// Built-in "http" ToolProvider (T7b): one `http_request` tool against the
// current env. Env-bound injection: URLs resolve against the run env's baseUrl
// and are restricted to that origin (plus any explicitly allowed origins), so
// the model cannot reach other environments or arbitrary hosts from this tool.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolContext, ToolProvider } from "../tools.js";

export interface HttpToolProviderOptions {
  /** Per-request timeout in milliseconds (default 15000). */
  timeoutMs?: number;
  /** Upper bound for the model-supplied per-request timeout override (default 60000). */
  maxTimeoutMs?: number;
  /** Response body cap handed back to the model, in characters (default 8000). */
  maxBodyChars?: number;
  /** Upper bound on response bytes downloaded per request (default 1 MiB). */
  maxDownloadBytes?: number;
  /** Extra origins the tool may reach in addition to the env's baseUrl origin. */
  allowedOrigins?: string[];
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BODY_CHARS = 8_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 1024 * 1024;

function allowedOriginSet(baseUrl: string, allowedOrigins: string[]): Set<string> {
  return new Set([new URL(baseUrl).origin, ...allowedOrigins]);
}

function resolveUrl(raw: string, baseUrl: string, allowedOrigins: Set<string>): URL {
  let resolved: URL;
  try {
    resolved = new URL(raw, baseUrl);
  } catch {
    throw new Error(`invalid URL "${raw}" (env baseUrl: ${baseUrl})`);
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    throw new Error(`unsupported protocol "${resolved.protocol}" — only http/https are allowed`);
  }
  if (!allowedOrigins.has(resolved.origin)) {
    throw new Error(
      `URL "${resolved.origin}" is outside the current environment — only the env base URL origin`
        + ` (${new URL(baseUrl).origin}) is reachable`,
    );
  }
  return resolved;
}

/** Stream the response body up to `maxBytes`; never buffer an unbounded body. */
async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; declaredBytes: number | null }> {
  const declared = Number(response.headers.get("content-length"));
  const declaredBytes = Number.isFinite(declared) && declared >= 0 ? declared : null;
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return { text: "", truncated: true, declaredBytes };
  }
  if (!response.body) {
    return { text: "", truncated: false, declaredBytes };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= maxBytes) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch (err) {
    // A cancelled/aborted read surfaces here; treat as truncation, not failure.
    if (!truncated) throw err;
  }
  return { text, truncated, declaredBytes };
}

export function createHttpRequestTool(context: ToolContext, options: HttpToolProviderOptions = {}): AgentTool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = Math.max(options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS, timeoutMs);
  const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const allowedOrigins = allowedOriginSet(context.env.baseUrl, options.allowedOrigins ?? []);
  return {
    name: "http_request",
    label: "HTTP request",
    description:
      "Perform an HTTP request against the system under test. Relative URLs are "
        + "resolved against the current environment's base URL; only that origin is "
        + "reachable. Returns status, headers and the body (parsed as JSON when possible).",
    parameters: Type.Object({
      url: Type.String({ description: "Path like /api/balance resolved against the env base URL (same-origin only)" }),
      method: Type.Optional(Type.String({ description: "HTTP method (default GET)" })),
      headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Request headers" })),
      body: Type.Optional(Type.String({ description: "Request body as a string (send JSON as JSON text)" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-request timeout in milliseconds (capped by the provider)" })),
    }),
    execute: async (_toolCallId, args) => {
      const { url, method, headers, body, timeoutMs: perCallTimeout } = args as {
        url?: unknown;
        method?: unknown;
        headers?: unknown;
        body?: unknown;
        timeoutMs?: unknown;
      };
      if (typeof url !== "string" || url.trim() === "") {
        throw new Error("http_request requires a non-empty string \"url\"");
      }
      const target = resolveUrl(url, context.env.baseUrl, allowedOrigins);
      const httpMethod = typeof method === "string" && method.trim() !== "" ? method.trim().toUpperCase() : "GET";
      const controller = new AbortController();
      // The model-supplied override never exceeds the provider ceiling, and
      // the run signal (hard-limit abort) always wins.
      const effectiveTimeout = Math.min(
        typeof perCallTimeout === "number" && perCallTimeout > 0 ? perCallTimeout : timeoutMs,
        maxTimeoutMs,
      );
      const signal = AbortSignal.any([controller.signal, context.signal]);
      const timer = setTimeout(() => controller.abort(), effectiveTimeout);
      let response: Response;
      try {
        response = await fetch(target, {
          method: httpMethod,
          headers: typeof headers === "object" && headers !== null && !Array.isArray(headers)
            ? Object.fromEntries(
              Object.entries(headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
            )
            : undefined,
          body: httpMethod === "GET" || httpMethod === "HEAD" || body === undefined ? undefined : String(body),
          signal,
          redirect: "manual",
        });
      } catch (err) {
        const message = controller.signal.aborted
          ? `http_request ${httpMethod} ${target} timed out after ${effectiveTimeout}ms`
          : context.signal.aborted
            ? `http_request ${httpMethod} ${target} aborted: run hard limit tripped`
            : `http_request ${httpMethod} ${target} failed: ${(err as Error).message}`;
        throw new Error(message);
      } finally {
        clearTimeout(timer);
      }

      const { text: rawBody, truncated, declaredBytes } = await readBodyCapped(response, maxDownloadBytes);
      const contentType = response.headers.get("content-type") ?? "";
      let parsed: unknown;
      if (!truncated && (contentType.includes("json") || rawBody.trimStart().startsWith("{") || rawBody.trimStart().startsWith("["))) {
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = undefined;
        }
      }
      const responseHeaders = Object.fromEntries(response.headers.entries());
      let bodyForModel: unknown;
      if (truncated) {
        bodyForModel = rawBody.length > maxBodyChars
          ? `${rawBody.slice(0, maxBodyChars)}…[truncated: response exceeded the ${maxDownloadBytes}-byte download cap`
            + `${declaredBytes !== null ? ` (content-length ${declaredBytes})` : ""}]`
          : `${rawBody}…[truncated: response exceeded the ${maxDownloadBytes}-byte download cap]`;
      } else {
        bodyForModel = parsed !== undefined
          ? parsed
          : rawBody.length > maxBodyChars
            ? `${rawBody.slice(0, maxBodyChars)}…[truncated ${rawBody.length} chars total]`
            : rawBody;
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: response.status,
            ok: response.ok,
            statusText: response.statusText,
            url: target.toString(),
            contentType,
            headers: responseHeaders,
            body: bodyForModel,
          }),
        }],
        details: { status: response.status, ok: response.ok },
      };
    },
  };
}

/** Built-in "http" provider: `http_request` against the current env. */
export function createHttpToolProvider(options: HttpToolProviderOptions = {}): ToolProvider {
  return {
    id: "http",
    description: "HTTP requests against the current environment (http_request).",
    createTools: (context) => [createHttpRequestTool(context, options)],
  };
}
