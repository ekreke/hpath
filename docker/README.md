# Docker topology

Local containers for HPath 1.0 (SPEC T2). See `compose.yaml` for the full
service list.

## Default stack

```sh
make up          # hpath-server (mock) + demo-app-dev + demo-app-staging
make logs        # tail all logs
make down        # stop and remove the stack
```

## Optional S3 backend (SeaweedFS)

The S3-compatible artifact backend (`HPATH_ARTIFACT_STORE=s3`) is not part of
the default stack. Start it with:

```sh
make up PROFILE=s3
```

SeaweedFS then answers on `127.0.0.1:8333` (S3 API) and `127.0.0.1:9333`
(master).

## Manual verification of the S3 artifact store

The server unit tests include an s3 backend round-trip suite. When SeaweedFS
is **not** reachable these tests `skip` (so `make test` stays green on
machines without docker); when it is reachable they actually exercise
upload/download/overwrite against a fresh test bucket.

```sh
make up PROFILE=s3
pnpm --filter @hpath/server test   # s3 round-trip tests run instead of skipping
```

Automating this in CI is deferred; until then this is a manual check that the
s3 backend still round-trips.
