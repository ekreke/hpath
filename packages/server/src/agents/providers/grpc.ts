// Built-in "grpc" ToolProvider (T7b): one `grpc_call` tool. Env-bound
// injection: the call target defaults to the current env's `grpc_target`
// variable (or the provider default), so calls stay on the environment unless
// the deployment explicitly allows a `target` override.
//
// Proto resolution is configuration, not guessing: the provider is constructed
// with the proto files the deployment knows about (e.g. fixtures/demo-app), and
// calls resolve against exactly those definitions.

import * as grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolContext, ToolProvider } from "../tools.js";

export interface GrpcToolProviderOptions {
  /** Absolute or cwd-relative proto file paths loaded for method resolution. */
  protoPaths?: string[];
  /** Fallback "host:port" when neither args nor env variables provide one. */
  defaultTarget?: string;
  /** Per-call deadline in milliseconds (default 10000). */
  timeoutMs?: number;
  /** Upper bound for the model-supplied per-call deadline override (default 60000). */
  maxTimeoutMs?: number;
  /** proto-loader include directories (for proto imports). */
  includeDirs?: string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TIMEOUT_MS = 60_000;

/** Parsed package definitions are immutable — cache them per proto file. */
const packageDefinitionCache = new Map<string, protoLoader.PackageDefinition>();

function loadPackageDefinition(protoPath: string, includeDirs?: string[]): protoLoader.PackageDefinition {
  const cached = packageDefinitionCache.get(protoPath);
  if (cached) return cached;
  const loaded = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs,
  });
  packageDefinitionCache.set(protoPath, loaded);
  return loaded;
}

/** proto-loader exposes client methods lowerCamelCased; cover snake_case too. */
function candidateMethodNames(rpcName: string): string[] {
  const lowerFirst = rpcName.charAt(0).toLowerCase() + rpcName.slice(1);
  const snakeToCamel = rpcName.includes("_")
    ? rpcName.toLowerCase().replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())
    : undefined;
  const candidates = [lowerFirst, rpcName];
  if (snakeToCamel) candidates.push(snakeToCamel);
  return [...new Set(candidates)];
}

/** proto-loader service constructor doubles as a grpc-js client constructor. */
type ServiceClientCtor = new (
  target: string,
  credentials: grpc.ChannelCredentials,
  options?: Record<string, unknown>,
) => grpc.Client;

function resolveService(grpcObject: Record<string, unknown>, serviceFullName: string): ServiceClientCtor | undefined {
  let current: unknown = grpcObject;
  for (const part of serviceFullName.split(".")) {
    if (typeof current !== "object" || current === null || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== "function") return undefined;
  return current as ServiceClientCtor;
}

export function createGrpcCallTool(context: ToolContext, options: GrpcToolProviderOptions = {}): AgentTool {
  const protoPaths = options.protoPaths ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = Math.max(options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS, timeoutMs);
  // One client per (target, service): a later call to a different target or
  // service must not silently reuse the first client's connection. All are
  // closed together at run end.
  const clients = new Map<string, grpc.Client>();
  context.evidence.registerCleanup(() => {
    for (const client of clients.values()) {
      try {
        client.close();
      } catch {
        // Swallowed: disposal must never mask the run outcome.
      }
    }
  });

  const ensureClient = (target: string, serviceFullName: string, serviceCtor: ServiceClientCtor): grpc.Client => {
    const key = `${target}|${serviceFullName}`;
    const cached = clients.get(key);
    if (cached) return cached;
    if (protoPaths.length === 0) {
      throw new Error("grpc_call has no proto files configured for this deployment");
    }
    // The proto-loader service constructor doubles as the client constructor.
    const client = new serviceCtor(target, grpc.credentials.createInsecure());
    clients.set(key, client);
    return client;
  };

  return {
    name: "grpc_call",
    label: "gRPC call",
    description:
      "Invoke a unary gRPC method, e.g. method \"demo.v1.BalanceService/GetBalance\". "
        + "The call goes to the current environment's gRPC target by default. "
        + "Methods resolve against the proto files registered for this deployment.",
    parameters: Type.Object({
      method: Type.String({ description: "Fully-qualified \"package.Service/Method\"" }),
      request: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Request message fields" })),
      target: Type.Optional(Type.String({ description: "\"host:port\" override (rarely needed; defaults to the env target)" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Call metadata" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-call deadline in milliseconds" })),
    }),
    execute: async (_toolCallId, args) => {
      const { method, request, target, metadata, timeoutMs: perCallTimeout } = args as {
        method?: unknown;
        request?: unknown;
        target?: unknown;
        metadata?: unknown;
        timeoutMs?: unknown;
      };
      if (typeof method !== "string" || !method.includes("/")) {
        throw new Error("grpc_call requires method as \"package.Service/Method\"");
      }
      if (typeof request !== "object" || request === null || Array.isArray(request)) {
        if (request !== undefined) throw new Error("grpc_call \"request\" must be an object");
      }

      // Env-bound target resolution: args override > env variable > provider default.
      const resolvedTarget =
        (typeof target === "string" && target.trim() !== "" && target.trim())
        || (typeof context.env.variables.grpc_target === "string" && context.env.variables.grpc_target)
        || options.defaultTarget;
      if (!resolvedTarget) {
        throw new Error("no gRPC target: pass \"target\", set env variable \"grpc_target\", or configure a provider default");
      }

      const [serviceFullName, rpcName] = method.split("/");
      let serviceCtor: ServiceClientCtor | undefined;
      let grpcObject: Record<string, unknown> = {};
      for (const protoPath of protoPaths) {
        const loaded = loadPackageDefinition(protoPath, options.includeDirs);
        grpcObject = grpc.loadPackageDefinition(loaded) as Record<string, unknown>;
        serviceCtor = resolveService(grpcObject, serviceFullName);
        if (serviceCtor) break;
      }
      if (!serviceCtor) {
        throw new Error(
          `service "${serviceFullName}" not found in the registered protos (${protoPaths.join(", ") || "none"})`,
        );
      }

      const grpcClient = ensureClient(resolvedTarget, serviceFullName, serviceCtor);
      const methodName = candidateMethodNames(rpcName).find(
        (name) => typeof (grpcClient as unknown as Record<string, unknown>)[name] === "function",
      );
      if (!methodName) {
        throw new Error(`rpc "${rpcName}" not found on service "${serviceFullName}"`);
      }

      const callMetadata = new grpc.Metadata();
      if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
        for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
          callMetadata.set(key, String(value));
        }
      }
      // The model-supplied deadline override never exceeds the provider
      // ceiling; the run abort signal cancels the in-flight call so the
      // wall-clock hard limit stays hard even mid-call.
      const deadline = new Date(Date.now() + Math.min(
        typeof perCallTimeout === "number" && perCallTimeout > 0 ? perCallTimeout : timeoutMs,
        maxTimeoutMs,
      ));

      return new Promise((resolve) => {
        let call: grpc.ClientUnaryCall | undefined;
        const onAbort = (): void => {
          // cancel() on a completed call is a no-op, so no finished guard needed.
          if (call) call.cancel();
        };
        context.signal.addEventListener("abort", onAbort, { once: true });
        const handler = (err: grpc.ServiceError | null, response: unknown): void => {
          context.signal.removeEventListener("abort", onAbort);
          // Structured exchange record for the run evidence stream (proto
          // request_record): recorded for error replies too — the status code
          // and details are part of the backend's story.
          context.events.append({
            kind: "request_record",
            direction: "grpc",
            method,
            target: `${resolvedTarget} ${serviceFullName}/${rpcName}`,
            requestJson: JSON.stringify({ metadata: metadata ?? {}, request: request ?? {} }),
            responseJson: JSON.stringify(
              err
                ? { ok: false, code: err.code, codeName: grpc.status[err.code] ?? String(err.code), details: err.details }
                : { ok: true, response },
            ),
          });
          if (err) {
            resolve({
              content: [{
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  target: resolvedTarget,
                  method,
                  code: err.code,
                  codeName: grpc.status[err.code] ?? String(err.code),
                  details: err.details,
                }),
              }],
              details: { ok: false, code: err.code },
            });
            return;
          }
          resolve({
            content: [{
              type: "text",
              text: JSON.stringify({ ok: true, target: resolvedTarget, method, response }),
            }],
            details: { ok: true },
          });
        };
        call = (grpcClient as unknown as Record<string, (...cbArgs: unknown[]) => grpc.ClientUnaryCall>)[methodName](
          request ?? {},
          callMetadata,
          { deadline },
          handler,
        );
      });
    },
  };
}

/** Built-in "grpc" provider: `grpc_call` against the current env's target. */
export function createGrpcToolProvider(options: GrpcToolProviderOptions = {}): ToolProvider {
  return {
    id: "grpc",
    description: "Unary gRPC calls against the current environment (grpc_call).",
    createTools: (context) => [createGrpcCallTool(context, options)],
  };
}
