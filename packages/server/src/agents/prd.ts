// PRD ingest (T9): turn uploaded PRD bytes into plain text for the
// analyze-agent, regardless of container format.
//
// Formats (docs/overview/agent-design.md):
//   - md   -> read directly (UTF-8 decode)
//   - docx -> mammoth (raw text extraction from WordprocessingML)
//   - pdf  -> pdf-parse (pdf.js text extraction)
//
// Library notes (kept here because they shape the dependency contract):
//   - mammoth 1.9.0 ships no TypeScript types; declarations live in
//     ./prd-libs.d.ts.
//   - pdf-parse 1.1.1 (2018) must be imported via the deep path
//     "pdf-parse/lib/pdf-parse.js": its index.js treats a missing
//     `module.parent` as "run as main" and executes a debug self-test that
//     reads a fixture file from the current working directory, which crashes
//     every ESM import.
//   - The pdf.js build bundled with pdf-parse (v1.10.100) rejects some
//     spec-valid minimal PDFs with FormatError "bad XRef entry" (it also
//     fails on the T3 seed fixture fixtures/prds/orders.pdf). PDFs carrying
//     a binary comment line after the header plus an /ID trailer entry are
//     accepted; the test fixtures are crafted accordingly.

import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

/** Supported PRD container formats (proto PrdFormat). */
export type PrdFormat = "md" | "docx" | "pdf";

export const PRD_FORMATS: readonly PrdFormat[] = ["md", "docx", "pdf"];

/** Map a filename to its PRD format; undefined for unsupported extensions. */
export function prdFormatFromFilename(filename: string): PrdFormat | undefined {
  const extension = filename.toLowerCase().split(".").pop();
  if (extension === "md" || extension === "markdown") return "md";
  if (extension === "docx") return "docx";
  if (extension === "pdf") return "pdf";
  return undefined;
}

/** Ingest failure with the offending format attached. */
export class PrdIngestError extends Error {
  readonly format: PrdFormat;

  constructor(format: PrdFormat, message: string, options?: { cause?: unknown }) {
    super(`${format} PRD ingest failed: ${message}`, options);
    this.name = "PrdIngestError";
    this.format = format;
  }
}

/** A PRD after ingest: the plain text the analyze-agent reasons over. */
export interface IngestedPrd {
  format: PrdFormat;
  /** Extracted text length in characters (after truncation). */
  chars: number;
  text: string;
}

/** Hard cap on the text handed to the model (PRDs in 1.0 are small). */
const MAX_PRD_CHARS = 200_000;

/** Hard cap on the raw uploaded bytes, checked BEFORE any decompression. */
export const MAX_PRD_BYTES = 20 * 1024 * 1024;

/**
 * Ingest PRD file bytes into plain text. Parsing errors are wrapped in
 * PrdIngestError so callers (the read_prd tool, T8's ParsePRD wiring) can
 * report them structurally instead of crashing the run.
 */
export async function ingestPrd(content: Buffer, format: PrdFormat): Promise<IngestedPrd> {
  // Size gate before parsing: a high-compression docx/pdf could otherwise
  // amplify a small upload into a large parse in server memory.
  if (content.byteLength > MAX_PRD_BYTES) {
    throw new PrdIngestError(format, `document exceeds the ${MAX_PRD_BYTES}-byte upload cap`);
  }
  let text: string;
  try {
    switch (format) {
      case "md":
        text = content.toString("utf8");
        break;
      case "docx": {
        const extracted = await mammoth.extractRawText({ buffer: content });
        text = extracted.value;
        break;
      }
      case "pdf": {
        // pdf-parse 1.1.1 misbehaves on the FIRST parse of a given PDF in a
        // process: its bundled pdf.js (v1.10.100) can reject a spec-valid
        // document with a spurious FormatError ("bad XRef entry", or a
        // recovery-mode lexer error) and then parse the identical buffer
        // successfully on retry (observed deterministically; real-world PDFs
        // do not hit this). Fallback: retry once before giving up so valid
        // PRDs are not lost to the library quirk. Both attempts failing is a
        // genuine parse error and surfaces as PrdIngestError.
        const parse = () => pdfParse(content);
        try {
          text = (await parse()).text;
        } catch (firstError) {
          try {
            text = (await parse()).text;
          } catch {
            throw firstError;
          }
        }
        break;
      }
    }
  } catch (err) {
    throw new PrdIngestError(format, (err as Error).message, { cause: err });
  }
  text = text.trim();
  if (text.length > MAX_PRD_CHARS) {
    text = `${text.slice(0, MAX_PRD_CHARS)}\n…[truncated after ${MAX_PRD_CHARS} characters]`;
  }
  return { format, chars: text.length, text };
}
