#!/usr/bin/env bash
# Generate TypeScript types from proto/hpath/v1/hpath.proto using protoc + ts-proto.
# Generated files are committed under packages/contract/src/gen (the shared
# @hpath/contract package) so consumers never need the toolchain to build.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p packages/contract/src/gen

protoc -I ./proto \
  --plugin=protoc-gen-ts_proto=./node_modules/.bin/protoc-gen-ts_proto \
  --ts_proto_out=packages/contract/src/gen \
  --ts_proto_opt=esModuleInterop=true,useOptionals=messages,env=node,outputClientImpl=false,outputServices=grpc-js,importSuffix=.js \
  proto/hpath/v1/hpath.proto

echo "Generated TS types into packages/contract/src/gen"

# Full descriptor set (with imports) for the reflection service at runtime.
protoc --include_imports -I ./proto \
  -o packages/contract/src/gen/hpath-descriptor.pb \
  proto/hpath/v1/hpath.proto

echo "Generated descriptor set at packages/contract/src/gen/hpath-descriptor.pb"
