// Shared gRPC error helpers. `grpcError` builds a plain ServiceError;
// `toGrpcError` maps typed repository errors onto status codes (mapping
// documented in db/errors.ts). Anything else passes through untouched: gRPC
// layer errors are already ServiceErrors, and unexpected failures must stay
// loud.

import { status } from "@grpc/grpc-js";
import type { ServiceError } from "@grpc/grpc-js";
import {
  ConflictError,
  ForeignKeyError,
  InvalidTransitionError,
  NotFoundError,
  RepositoryError,
} from "../db/errors.js";

export function grpcError(code: status, message: string): ServiceError {
  return { code, details: message, message, name: "ServiceError" } as ServiceError;
}

export function toGrpcError(err: unknown): ServiceError {
  if (err instanceof NotFoundError) {
    return grpcError(status.NOT_FOUND, err.message);
  }
  if (err instanceof ConflictError) {
    return grpcError(status.ALREADY_EXISTS, err.message);
  }
  if (err instanceof InvalidTransitionError) {
    return grpcError(status.FAILED_PRECONDITION, err.message);
  }
  if (err instanceof ForeignKeyError) {
    return grpcError(status.INVALID_ARGUMENT, err.message);
  }
  if (err instanceof RepositoryError) {
    return grpcError(status.INTERNAL, err.message);
  }
  return err as ServiceError;
}
