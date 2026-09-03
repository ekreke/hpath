// Built-in "http" ToolProvider (T7b): one `http_request` tool against the
// current env. Env-bound injection: relative URLs resolve against the run
// env's baseUrl, so other environments are unreachable from this tool.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolContext, ToolProvider } from "../tools.js";

export interface HttpToolProviderOptions {
  /** Per-request timeout in milliseconds (default 15000). */
  timeoutMs?: number;
  /** Response body cap handed back to the model, in characters (default 8000). */
  maxBodyChars?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_CHARS = 8_000;

function resolveUrl(raw: string, baseUrl: string): URL {
  let resolved: URL;
  try {
    resolved = new URL(raw, baseUrl);
  } catch {
    throw new Error(`invalid URL "${raw}" (env baseUrl: ${baseUrl})`);
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    throw new Error(`unsupported protocol "${resolved.protocol}" — only http/https are allowed`);
  }
  return resolved;
}

export function createHttpRequestTool(context: ToolContext, options: HttpToolProviderOptions = {}): AgentTool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  return {
    name: "http_request",
    label: "HTTP request",
    description:
      "Perform an HTTP request against the system under test. Relative URLs are "
        + "resolved against the current environment's base URL. Returns status, "
        + "headers and the body (parsed as JSON when possible).",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL, or path like /api/balance resolved against the env base URL" }),
      method: Type.Optional(Type.String({ description: "HTTP method (default GET)" })),
      headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Request headers" })),
      body: Type.Optional(Type.String({ description: "Request body as a string (send JSON as JSON text)" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-request timeout in milliseconds" })),
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
      const target = resolveUrl(url, context.env.baseUrl);
      const httpMethod = typeof method === "string" && method.trim() !== "" ? method.trim().toUpperCase() : "GET";
      const controller = new AbortController();
      const effectiveTimeout = typeof perCallTimeout === "number" && perCallTimeout > 0 ? perCallTimeout : timeoutMs;
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
          signal: controller.signal,
          redirect: "manual",
        });
      } catch (err) {
        const message = controller.signal.aborted
          ? `http_request ${httpMethod} ${target} timed out after ${effectiveTimeout}ms`
          : `http_request ${httpMethod} ${target} failed: ${(err as Error).message}`;
        throw new Error(message);
      } finally {
        clearTimeout(timer);
      }

      const rawBody = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      let parsed: unknown;
      if (contentType.includes("json") || rawBody.trimStart().startsWith("{") || rawBody.trimStart().startsWith("[")) {
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = undefined;
        }
      }
      const responseHeaders = Object.fromEntries(response.headers.entries());
      const bodyForModel = parsed !== undefined
        ? parsed
        : rawBody.length > maxBodyChars
          ? `${rawBody.slice(0, maxBodyChars)}…[truncated ${rawBody.length} chars total]`
          : rawBody;
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
