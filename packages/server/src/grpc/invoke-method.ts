// Real-mode InvokeMethod handler: manual unary gRPC calls from the API list
// view ("try it out"). Same discipline as the run-time grpc_call tool: the
// method must be defined by the project's proto assets (allowlist validated
// before any network I/O) and the target comes from the env's grpc_address.
// The project's proto bytes are materialized into a per-call temp dir that is
// removed when the call settles — errors resolve in-band (ok=false) like the
// tool does, so a failed call is still a valid InvokeMethodResponse.

import { rmSync } from "node:fs";
import * as grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { status } from "@grpc/grpc-js";
import type { sendUnaryData, ServerUnaryCall } from "@grpc/grpc-js";
import type { InvokeMethodRequest, InvokeMethodResponse } from "@hpath/contract";
import type { ProjectApiSurface } from "../agents/types.js";
import { buildProjectApiSurface, type RunExecutionDeps } from "./run-execution.js";
import { grpcError, toGrpcError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

type ServiceClientCtor = new (
  target: string,
  credentials: grpc.ChannelCredentials,
  options?: Record<string, unknown>,
) => grpc.Client;

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

/** One unary call against materialized proto paths; resolves in-band errors. */
function invokeUnary(options: {
  protoPaths: string[];
  target: string;
  method: string;
  request: Record<string, unknown>;
  timeoutMs: number;
}): Promise<{ ok: boolean; response: unknown; errorCode?: string; errorDetails?: string }> {
  const { protoPaths, target, method, request, timeoutMs } = options;
  const [serviceFullName, rpcName] = method.split("/");
  let serviceCtor: ServiceClientCtor | undefined;
  let grpcObject: Record<string, unknown> = {};
  for (const protoPath of protoPaths) {
    // No cache: the paths are per-call temp files removed right after.
    const loaded = protoLoader.loadSync(protoPath, {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    grpcObject = grpc.loadPackageDefinition(loaded) as Record<string, unknown>;
    serviceCtor = resolveService(grpcObject, serviceFullName);
    if (serviceCtor) break;
  }
  if (!serviceCtor) {
    throw grpcError(
      status.FAILED_PRECONDITION,
      `service "${serviceFullName}" not found in the project's protos (${protoPaths.join(", ") || "none"})`,
    );
  }
  const client = new serviceCtor(target, grpc.credentials.createInsecure());
  const methodName = candidateMethodNames(rpcName).find(
    (name) => typeof (client as unknown as Record<string, unknown>)[name] === "function",
  );
  if (!methodName) {
    client.close();
    throw grpcError(status.FAILED_PRECONDITION, `rpc "${rpcName}" not found on service "${serviceFullName}"`);
  }
  const deadline = new Date(Date.now() + timeoutMs);
  return new Promise((resolve) => {
    const handler = (err: grpc.ServiceError | null, response: unknown): void => {
      client.close();
      if (err) {
        resolve({
          ok: false,
          response: { code: err.code, codeName: grpc.status[err.code] ?? String(err.code), details: err.details },
          errorCode: grpc.status[err.code] ?? String(err.code),
          errorDetails: err.details,
        });
        return;
      }
      resolve({ ok: true, response });
    };
    (client as unknown as Record<string, (...cbArgs: unknown[]) => grpc.ClientUnaryCall>)[methodName](
      request,
      new grpc.Metadata(),
      { deadline },
      handler,
    );
  });
}

export function createInvokeMethodHandler(deps: RunExecutionDeps) {
  return (
    call: ServerUnaryCall<InvokeMethodRequest, InvokeMethodResponse>,
    callback: sendUnaryData<InvokeMethodResponse>,
  ): void => {
    void (async () => {
      let surface: ProjectApiSurface | undefined;
      try {
        const { envId, method } = call.request;
        if (!envId) {
          throw grpcError(status.INVALID_ARGUMENT, "env_id is required");
        }
        if (!method || !method.includes("/")) {
          throw grpcError(status.INVALID_ARGUMENT, 'method is required as "package.Service/Method"');
        }
        const env = deps.db.envs.getRequired(envId);
        if (!env.grpcAddress) {
          throw grpcError(status.FAILED_PRECONDITION, `env "${env.name}" has no gRPC address`);
        }
        surface = await buildProjectApiSurface(deps.db, deps.artifactStore, env.projectId);
        if (!surface || surface.methods.length === 0) {
          throw grpcError(status.FAILED_PRECONDITION, "project has no API surface (upload a proto asset first)");
        }
        // Same hard validation as the run-time grpc_call tool: only methods
        // defined by the project's proto assets are callable.
        const allowed = new Set(surface.methods.map((m) => `${m.service}/${m.method}`));
        if (!allowed.has(method)) {
          throw grpcError(
            status.INVALID_ARGUMENT,
            `gRPC method "${method}" is not defined in this project's API surface. Defined methods:\n`
              + [...allowed].map((key) => `- ${key}`).join("\n"),
          );
        }
        let request: Record<string, unknown> = {};
        const trimmed = (call.request.requestJson ?? "").trim();
        if (trimmed) {
          const parsed: unknown = JSON.parse(trimmed);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw grpcError(status.INVALID_ARGUMENT, "request_json must be a JSON object");
          }
          request = parsed as Record<string, unknown>;
        }
        const timeoutMs = Math.min(
          call.request.timeoutMs && call.request.timeoutMs > 0 ? call.request.timeoutMs : DEFAULT_TIMEOUT_MS,
          MAX_TIMEOUT_MS,
        );
        const started = Date.now();
        const result = await invokeUnary({
          protoPaths: surface.protoPaths,
          target: env.grpcAddress,
          method,
          request,
          timeoutMs,
        });
        callback(null, {
          ok: result.ok,
          responseJson: JSON.stringify(result.response ?? null),
          errorCode: result.errorCode ?? "",
          errorDetails: result.errorDetails ?? "",
          target: env.grpcAddress,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        callback(toGrpcError(err));
      } finally {
        if (surface?.protoDir) {
          try {
            rmSync(surface.protoDir, { recursive: true, force: true });
          } catch {
            // Swallowed: temp cleanup must never mask the call result.
          }
        }
      }
    })();
  };
}
