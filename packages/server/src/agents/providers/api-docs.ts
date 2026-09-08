// Built-in "api-docs" ToolProvider (T22): read access to the project's
// registered API surface (its uploaded proto assets). Materializes no tools
// when the project has no API surface, so agents of proto-less projects are
// unaffected; with a surface, the execute-agent can list the registered
// methods and pull full request/response schemas on demand.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolContext, ToolProvider } from "../tools.js";
import { methodKey } from "../../assets/proto-doc.js";

/** Cap for one describe_api answer (a handful of message schemas). */
const DESCRIBE_MAX_CHARS = 20_000;

function listApisTool(context: ToolContext): AgentTool {
  const surface = context.projectApi!;
  return {
    name: "list_apis",
    label: "List registered APIs",
    description:
      "List the gRPC methods defined in this project's registered proto assets "
        + "(the same allowlist grpc_call enforces).",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({
          methods: surface.methods.map((method) => methodKey(method)),
          note: "grpc_call only accepts these exact \"package.Service/Method\" keys.",
        }, null, 2),
      }],
      details: { methods: surface.methods.length },
    }),
  };
}

function describeApiTool(context: ToolContext): AgentTool {
  const surface = context.projectApi!;
  return {
    name: "describe_api",
    label: "Describe registered API",
    description:
      "Full documentation (request/response message schemas) for methods matching a "
        + "\"package.Service/Method\" key, method name or service name (case-insensitive substring).",
    parameters: Type.Object({
      query: Type.String({ description: "e.g. \"demo.v1.BalanceService/GetBalance\", \"GetBalance\" or \"BalanceService\"" }),
    }),
    execute: async (_toolCallId, args) => {
      const query = typeof (args as { query?: unknown }).query === "string"
        ? (args as { query: string }).query.trim().toLowerCase()
        : "";
      if (query === "") {
        throw new Error("describe_api requires a non-empty \"query\"");
      }
      const matches = surface.methods.filter((method) => {
        const key = methodKey(method).toLowerCase();
        return (
          key.includes(query)
          || method.method.toLowerCase().includes(query)
          || method.service.toLowerCase().includes(query)
          || method.request.toLowerCase().includes(query)
          || method.response.toLowerCase().includes(query)
        );
      });
      if (matches.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: `no registered method matches "${query}"`,
              methods: surface.methods.map((method) => methodKey(method)),
            }),
          }],
          details: { matches: 0 },
        };
      }
      let text = matches.map((method) => method.doc).join("\n\n");
      if (text.length > DESCRIBE_MAX_CHARS) {
        text = `${text.slice(0, DESCRIBE_MAX_CHARS)}…[truncated — narrow the query]`;
      }
      return {
        content: [{ type: "text", text }],
        details: { matches: matches.length },
      };
    },
  };
}

/** Built-in "api-docs" provider: project API surface readers (T22). */
export function createApiDocsToolProvider(): ToolProvider {
  return {
    id: "api-docs",
    description:
      "Read access to the project's registered API surface: list_apis + describe_api "
        + "(no tools when the project has no proto assets).",
    createTools: (context) => {
      const surface = context.projectApi;
      if (!surface || surface.methods.length === 0) {
        return [];
      }
      return [listApisTool(context), describeApiTool(context)];
    },
  };
}
