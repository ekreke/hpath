// gRPC server assembly: Hpath service (ts-proto definitions) + server
// reflection driven by the protoc-generated descriptor set.
//
// Why not `new ReflectionService(protoLoader.load(...))`? proto-loader
// reorients loaded files: it merges files per package, renames them
// (hpath_v1.proto), and drops cross-file dependencies and map-entry scoping.
// Reflection clients (grpcurl) then fail to resolve symbols. Instead we hand
// the reflection service the raw, untouched FileDescriptorProtos from the
// protoc-generated descriptor set, preserving names, dependencies, and nested
// map entries.

import * as grpc from "@grpc/grpc-js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ReflectionService } from "@grpc/reflection";
import { HpathService, descriptorPath } from "@hpath/contract";
import type { ServerMode } from "./hpath.js";
import { createHpathService } from "./hpath.js";
import type { MockStore } from "../mock/store.js";
import type { HpathDb } from "../db/index.js";

const require = createRequire(import.meta.url);
// Uses protobufjs/ext/descriptor to decode the descriptor set. This path is a
// semi-internal protobufjs API: protobufjs is pinned to an exact version
// (7.6.6) in package.json. If an upgrade breaks it, the wrapper below fails
// loudly with a pointer to this pin instead of misbehaving silently.
function loadDescriptorTypes(): {
  FileDescriptorSet: { decode(buffer: Uint8Array): { file: unknown[] } };
  FileDescriptorProto: { encode(file: unknown): { finish(): Uint8Array } };
} {
  try {
    return require("protobufjs/ext/descriptor");
  } catch (err) {
    throw new Error(
      "Failed to load protobufjs/ext/descriptor (required for gRPC reflection). "
        + "protobufjs is pinned to 7.6.6 in package.json; adjust this loader if the API moved.",
      { cause: err },
    );
  }
}

function buildReflectionService(): ReflectionService {
  const descriptor = loadDescriptorTypes();
  // Descriptor set ships inside the @hpath/contract package (see descriptorPath()).
  const set = descriptor.FileDescriptorSet.decode(readFileSync(descriptorPath()));
  const fileDescriptorProtos = set.file.map((file) =>
    descriptor.FileDescriptorProto.encode(file).finish(),
  );
  // The reflection implementation iterates package-definition values and reads
  // `fileDescriptorProtos` off each value; wrap the raw set accordingly.
  const syntheticPackage = { descriptors: { fileDescriptorProtos } };
  return new ReflectionService(syntheticPackage as never);
}

export interface StartServerOptions {
  mode: ServerMode;
  port: number;
  /** Bind address; defaults to the loopback interface. Containers pass 0.0.0.0. */
  host?: string;
  /** Required in mock mode: the in-memory seed store. */
  store?: MockStore;
  /** Required in real mode: the SQLite facade backing the read path (T3). */
  db?: HpathDb;
}

export interface RunningServer {
  port: number;
  shutdown: () => Promise<void>;
  /** Immediately close all connections; used as shutdown fallback. */
  forceShutdown: () => void;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const server = new grpc.Server();
  server.addService(HpathService, createHpathService(options.mode, options.store, options.db));
  buildReflectionService().addToServer(server);

  const boundPort = await new Promise<number>((resolve, reject) => {
    const host = options.host ?? "127.0.0.1";
    server.bindAsync(`${host}:${options.port}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) {
        reject(err);
      } else {
        resolve(port);
      }
    });
  });

  return {
    port: boundPort,
    shutdown: () =>
      new Promise<void>((resolve) => {
        server.tryShutdown(() => resolve());
      }),
    forceShutdown: () => server.forceShutdown(),
  };
}
