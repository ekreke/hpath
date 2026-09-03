// Ambient type declarations for the PRD ingest dependencies (T9).
//
// Neither library ships TypeScript types and we keep the dependency surface
// minimal (no @types packages), so only the functions the ingest module uses
// are declared here.

declare module "mammoth" {
  export interface ExtractRawTextResult {
    /** The plain text extracted from the document. */
    value: string;
    /** Mammoth warnings (unused here). */
    messages: unknown[];
  }
  export function extractRawText(input: { buffer: Buffer }): Promise<ExtractRawTextResult>;
}

declare module "pdf-parse/lib/pdf-parse.js" {
  export interface PdfParseResult {
    numpages: number;
    text: string;
    info: Record<string, unknown> | null;
    metadata: unknown | null;
    version: string | null;
  }
  export interface PdfParseOptions {
    /** Bundled pdf.js build, e.g. "v1.10.100" (default). */
    version?: string;
    /** Page cap; 0 = all pages. */
    max?: number;
    pagerender?: (pageData: unknown) => Promise<string>;
  }
  function pdfParse(data: Buffer, options?: PdfParseOptions): Promise<PdfParseResult>;
  export = pdfParse;
}
