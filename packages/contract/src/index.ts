// Shared gRPC contract for HPath: generated protobuf types (ts-proto) plus
// the descriptor set used by the server's reflection service. Generated files
// are committed so consumers never need the protoc toolchain to build.
// Regenerate with `pnpm gen:proto`.

export * from "./gen/hpath/v1/hpath.js";

/**
 * Absolute path of the bundled descriptor set. Resolved relative to this
 * module's location: src/index.ts -> src/gen/, dist/index.js -> dist/gen/.
 */
export function descriptorPath(): string {
  return new URL("./gen/hpath-descriptor.pb", import.meta.url).pathname;
}
