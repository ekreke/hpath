// Proto bundle parsing (T22): turn uploaded .proto files into the project's
// API surface — a markdown API document plus a structured method list.
//
// The parser is pure and deterministic (no LLM): every uploaded file is parsed
// in isolation with protobufjs (comments preserved via keepComments), the
// per-file definitions are merged into one in-memory Root (package namespaces
// merged by name, duplicate types rejected), and the result is walked for
// services / methods / message schemas.
//
// Import handling: imports are validated for bundle completeness (every
// `import "x.proto"` must resolve to an uploaded file by exact name, base
// name or path suffix) but do NOT drive type resolution — proto type
// references are resolved by fully-qualified name across the merged root, so
// an uploaded file may import a path that differs from its uploaded filename
// (e.g. `import "sub/common.proto"` alongside an upload named common.proto).
//
// Drive-by guarantees the run path relies on:
//   - request/response types of every method resolve against the bundle,
//   - duplicate type definitions across files fail with the offending name,
//   - unknown type references (e.g. google.protobuf.Timestamp without the
//     well-known file uploaded) fail with a descriptive error.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import protobuf from "protobufjs";
import type { Namespace } from "protobufjs";

/** Hard caps for one proto bundle upload. */
export const MAX_PROTO_FILES = 20;
export const MAX_PROTO_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PROTO_TOTAL_BYTES = 5 * 1024 * 1024;

/** Cap for the compact API-surface summary injected into agent prompts. */
export const API_SUMMARY_MAX_CHARS = 4_000;

export interface ProtoBundleFile {
  filename: string;
  content: Buffer | string;
}

/** One method of the parsed API surface (methods_json entries). */
export interface ApiMethodDoc {
  /** Fully qualified service name without the leading dot: demo.v1.BalanceService. */
  service: string;
  /** RPC name: GetBalance. */
  method: string;
  /** Fully qualified request message name (no leading dot). */
  request: string;
  /** Fully qualified response message name (no leading dot). */
  response: string;
  /** Leading comment on the method ("" when absent). */
  comment: string;
  /** Markdown section documenting the method (signature + message schemas). */
  doc: string;
}

export interface ParsedProtoBundle {
  entryFilename: string;
  fileCount: number;
  totalBytes: number;
  /** Full markdown API document (header + one section per method). */
  apiDoc: string;
  methods: ApiMethodDoc[];
  /** Compact one-line-per-method summary (prompt injection payload). */
  summary: string;
}

/** Bundle rejected with a human-readable reason (file + import/line detail). */
export class ProtoBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtoBundleError";
  }
}

function fullNameOf(type: { fullName: string }): string {
  return type.fullName.replace(/^\./, "");
}

function safeName(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file.proto";
}

/** Loose import matching: exact -> base name -> path suffix. */
function resolveImport(
  importPath: string,
  byName: Map<string, ProtoBundleFile>,
  files: ProtoBundleFile[],
): ProtoBundleFile | undefined {
  const direct = byName.get(importPath);
  if (direct) return direct;
  const base = importPath.split("/").pop() ?? importPath;
  const byBase = byName.get(base);
  if (byBase) return byBase;
  return files.find((file) => importPath.endsWith(`/${file.filename}`));
}

interface FieldDoc {
  name: string;
  type: string;
  rule: string;
  comment: string;
}

function fieldDocs(message: protobuf.Type): FieldDoc[] {
  return message.fieldsArray.map((field) => {
    let type: string;
    if (field instanceof protobuf.MapField) {
      type = `map<${field.keyType}, ${field.type}>`;
    } else {
      const resolved = (field as unknown as { resolvedType?: protobuf.Type | protobuf.Enum | null }).resolvedType;
      type = resolved ? fullNameOf(resolved) : field.type;
    }
    return {
      name: field.name,
      type,
      rule: field.repeated ? "repeated" : field.partOf ? "oneof" : "",
      comment: field.comment ?? "",
    };
  });
}

/** Render one message (and, depth-capped, its named field types) as markdown. */
function renderMessage(
  message: protobuf.Type,
  lines: string[],
  seen: Set<string>,
  depth: number,
): void {
  const name = fullNameOf(message);
  if (seen.has(name)) return;
  seen.add(name);
  lines.push(`#### message ${name}`);
  if (message.comment) lines.push(`> ${message.comment.replace(/\n/g, "\n> ")}`);
  lines.push("");
  lines.push("| field | type | rule | note |");
  lines.push("|---|---|---|---|");
  for (const field of fieldDocs(message)) {
    lines.push(`| ${field.name} | \`${field.type}\` | ${field.rule} | ${field.comment} |`);
  }
  lines.push("");
  if (depth >= 5) return;
  // Named field types first, then nested types of this message.
  for (const field of message.fieldsArray) {
    const resolved = (field as unknown as { resolvedType?: protobuf.Type | protobuf.Enum | null }).resolvedType;
    if (resolved instanceof protobuf.Type) renderMessage(resolved, lines, seen, depth + 1);
  }
  for (const nested of message.nestedArray) {
    if (nested instanceof protobuf.Type) renderMessage(nested, lines, seen, depth + 1);
  }
}

function renderEnum(enumType: protobuf.Enum, lines: string[], seen: Set<string>): void {
  const name = fullNameOf(enumType);
  if (seen.has(name)) return;
  seen.add(name);
  lines.push(`#### enum ${name}`);
  if (enumType.comment) lines.push(`> ${enumType.comment.replace(/\n/g, "\n> ")}`);
  lines.push("");
  for (const [valueName, id] of Object.entries(enumType.values)) {
    lines.push(`- \`${valueName} = ${id}\``);
  }
  lines.push("");
}

/** Parse options protobufjs honors at runtime but omits from its TS types
 * (comment retention is what keeps method/field docs in the API surface). */
interface ProtoParseOptions extends protobuf.IParseOptions {
  keepComments?: boolean;
}

const PARSE_OPTIONS: ProtoParseOptions = {
  keepCase: true,
  keepComments: true,
  alternateCommentMode: true,
};

/** Parse one file's imports; throws for files protobufjs cannot parse. */
function importsOf(filename: string, content: string): string[] {
  try {
    const parsed = protobuf.parse(content, PARSE_OPTIONS);
    return parsed.imports ?? [];
  } catch (err) {
    throw new ProtoBundleError(`failed to parse "${filename}": ${(err as Error).message}`);
  }
}

/**
 * Parse an uploaded proto bundle into the API surface. Synchronous and pure;
 * errors are ProtoBundleError with file-level detail.
 */
export function parseProtoBundle(
  files: ProtoBundleFile[],
  entryFilename?: string,
): ParsedProtoBundle {
  if (files.length === 0) {
    throw new ProtoBundleError("a proto bundle needs at least one .proto file");
  }
  if (files.length > MAX_PROTO_FILES) {
    throw new ProtoBundleError(`a proto bundle holds at most ${MAX_PROTO_FILES} files (got ${files.length})`);
  }
  let totalBytes = 0;
  const byName = new Map<string, ProtoBundleFile>();
  const names = new Set<string>();
  for (const file of files) {
    if (!file.filename || file.filename.includes("/") || file.filename.includes("\\") || file.filename.includes("..")) {
      throw new ProtoBundleError(`invalid proto filename "${file.filename}" (base names only)`);
    }
    const bytes = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > MAX_PROTO_FILE_BYTES) {
      throw new ProtoBundleError(`"${file.filename}" exceeds the ${MAX_PROTO_FILE_BYTES}-byte per-file cap`);
    }
    if (names.has(file.filename)) {
      throw new ProtoBundleError(`duplicate filename in bundle: "${file.filename}"`);
    }
    names.add(file.filename);
    byName.set(file.filename, file);
  }
  if (totalBytes > MAX_PROTO_TOTAL_BYTES) {
    throw new ProtoBundleError(`bundle exceeds the ${MAX_PROTO_TOTAL_BYTES}-byte total cap (got ${totalBytes})`);
  }

  // Decode once; every later consumer reads the string form.
  const contents = new Map<string, string>();
  for (const file of files) {
    contents.set(file.filename, Buffer.isBuffer(file.content) ? file.content.toString("utf8") : file.content);
  }

  // --- import validation (bundle completeness) -----------------------------
  const importedBy = new Map<string, Set<string>>(); // imported file -> importers
  for (const file of files) {
    for (const importPath of importsOf(file.filename, contents.get(file.filename)!)) {
      const target = resolveImport(importPath, byName, files);
      if (!target) {
        throw new ProtoBundleError(
          `"${file.filename}" imports "${importPath}" which is not part of the upload — upload it too`,
        );
      }
      if (!importedBy.has(target.filename)) importedBy.set(target.filename, new Set());
      importedBy.get(target.filename)!.add(file.filename);
    }
  }

  // --- entry file inference -------------------------------------------------
  let entry: string;
  if (entryFilename) {
    if (!names.has(entryFilename)) {
      throw new ProtoBundleError(`entry_filename "${entryFilename}" is not one of the uploaded files`);
    }
    entry = entryFilename;
  } else {
    const candidates = files.filter((file) => !(importedBy.get(file.filename)?.size));
    if (candidates.length === 1) {
      entry = candidates[0].filename;
    } else {
      throw new ProtoBundleError(
        candidates.length === 0
          ? "every uploaded file is imported by another file — pass entry_filename"
          : `ambiguous bundle: ${candidates.map((file) => `"${file.filename}"`).join(", ")} are not imported by any other file — pass entry_filename`,
      );
    }
  }

  // --- merge into one root --------------------------------------------------
  // Each file is parsed in isolation (so keepComments applies) and its
  // package namespaces are merged by name; per-file wrappers keep the merge
  // from colliding on equal top-level names across files.
  const root = new protobuf.Root();
  const wrappers: Namespace[] = [];
  try {
    for (const file of files) {
      const parsed = protobuf.parse(contents.get(file.filename)!, PARSE_OPTIONS);
      const wrapper = new protobuf.Namespace("");
      wrapper.name = safeName(file.filename);
      for (const child of parsed.root.nestedArray) {
        wrapper.add(child);
      }
      root.add(wrapper);
      wrappers.push(wrapper);
    }
    for (const wrapper of wrappers) {
      for (const pkg of wrapper.nestedArray.slice() as protobuf.Namespace[]) {
        wrapper.remove(pkg);
        const existing = root.nested?.[pkg.name] as protobuf.Namespace | undefined;
        if (!existing) {
          root.add(pkg);
        } else {
          for (const child of pkg.nestedArray.slice()) {
            pkg.remove(child);
            existing.add(child); // throws on duplicate type names across files
          }
        }
      }
      root.remove(wrapper);
    }
  } catch (err) {
    if (err instanceof ProtoBundleError) throw err;
    throw new ProtoBundleError(`invalid bundle: ${(err as Error).message}`);
  }
  try {
    root.resolveAll();
  } catch (err) {
    throw new ProtoBundleError(`bundle does not resolve: ${(err as Error).message}`);
  }

  // --- walk services ---------------------------------------------------------
  const services: protobuf.Service[] = [];
  const walk = (namespace: protobuf.Namespace): void => {
    for (const nested of namespace.nestedArray) {
      if (nested instanceof protobuf.Service) services.push(nested);
      if (nested instanceof protobuf.Namespace) walk(nested);
    }
  };
  walk(root);

  const methods: ApiMethodDoc[] = [];
  const sections: string[] = [];
  for (const service of services) {
    for (const method of service.methodsArray) {
      const requestType = method.resolvedRequestType;
      const responseType = method.resolvedResponseType;
      if (!requestType || !responseType) {
        throw new ProtoBundleError(
          `method ${fullNameOf(service)}/${method.name}: request/response type does not resolve inside the bundle`,
        );
      }
      const lines: string[] = [];
      lines.push(`### ${fullNameOf(service)}/${method.name}`);
      if (method.comment) lines.push(`> ${method.comment.replace(/\n/g, "\n> ")}`);
      lines.push("");
      lines.push(`- request: \`${fullNameOf(requestType)}\``);
      lines.push(`- response: \`${fullNameOf(responseType)}\``);
      lines.push("");
      const seen = new Set<string>();
      renderMessage(requestType, lines, seen, 0);
      renderMessage(responseType, lines, seen, 0);
      for (const field of [...requestType.fieldsArray, ...responseType.fieldsArray]) {
        const resolved = (field as unknown as { resolvedType?: protobuf.Type | protobuf.Enum | null }).resolvedType;
        if (resolved instanceof protobuf.Enum) renderEnum(resolved, lines, seen);
      }
      const doc = lines.join("\n");
      sections.push(doc);
      methods.push({
        service: fullNameOf(service),
        method: method.name,
        request: fullNameOf(requestType),
        response: fullNameOf(responseType),
        comment: method.comment ?? "",
        doc,
      });
    }
  }

  const header = [
    `# API surface (parsed from ${files.length} proto file${files.length === 1 ? "" : "s"})`,
    "",
    `Entry file: \`${entry}\`. Files: ${files.map((file) => `\`${file.filename}\``).join(", ")}.`,
    "",
  ].join("\n");
  const apiDoc = `${header}${sections.join("\n")}`;

  return {
    entryFilename: entry,
    fileCount: files.length,
    totalBytes,
    apiDoc,
    methods,
    summary: summarizeMethods(methods),
  };
}

/** Compact, prompt-shaped method list ("service/method(request) -> response"). */
export function summarizeMethods(methods: ApiMethodDoc[]): string {
  const lines: string[] = [];
  for (const method of methods) {
    lines.push(`- ${method.service}/${method.method}(${method.request}) -> ${method.response}${method.comment ? ` — ${method.comment}` : ""}`);
  }
  let text = lines.join("\n");
  if (text.length > API_SUMMARY_MAX_CHARS) {
    text = `${text.slice(0, API_SUMMARY_MAX_CHARS)}…[truncated — use describe_api for details]`;
  }
  return text;
}

/** Wire key of one method ("package.Service/Method") — the grpc_call shape. */
export function methodKey(method: ApiMethodDoc): string {
  return `${method.service}/${method.method}`;
}

/**
 * Materialize a bundle's raw bytes into a per-run temp directory so the
 * existing proto-loader path (grpc_call) can resolve the project's services.
 * The caller owns cleanup (rmSync recursive on run settle).
 */
export function materializeProtoFiles(
  files: ProtoBundleFile[],
): { dir: string; paths: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "hpath-protos-"));
  const paths: string[] = [];
  for (const file of files) {
    const path = join(dir, safeName(file.filename));
    writeFileSync(path, Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8"));
    paths.push(path);
  }
  return { dir, paths };
}
