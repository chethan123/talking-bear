# The container image

The image is a static Go server (`server/`, stdlib only) with the built PWA embedded, on
`gcr.io/distroless/static-debian13:nonroot`. The [`Dockerfile`](../Dockerfile) follows plan §4.8.2. CI builds it in
the `image-build` job of [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Stages

| Stage | Base (pinned by index digest) | Runs on | What it does |
|---|---|---|---|
| `web` | `node:24.21.0-alpine3.24` | `$BUILDPLATFORM` | `pnpm install --frozen-lockfile`, then `pnpm build --mode "$BUILD_MODE"` → `node scripts/check-dist.mjs dist "$BUILD_MODE"` → `pnpm size-limit` → `node scripts/precompress.mjs dist` |
| `server` | `golang:1.27.1-alpine3.24` | `$BUILDPLATFORM` | `go vet ./...` and `go test ./...` with the real `dist` embedded (no `noembed` tag), then a static cross-compile for `$TARGETOS/$TARGETARCH` |
| final | `gcr.io/distroless/static-debian13:nonroot` | target | `/bearserve` only; `GOMEMLIMIT=48MiB`, `USER 65532:65532`, port 8080 |

The shipped bytes are the checked bytes (plan §9): check-dist and size-limit run on exactly the `dist` that gets
precompressed and embedded. A check-dist failure (for example a `__bearTest` needle in a production build) fails the
`web` stage, so no image is produced.

Both build stages run on the build platform, and Go cross-compiles, so a multi-arch build needs no QEMU.

## Build

```sh
# production image
docker buildx build --load --platform linux/amd64 -t bear:local .

# e2e image: dist built with --mode e2e (test hooks on), check-dist's positive control
docker buildx build --load --platform linux/amd64 --build-arg BUILD_MODE=e2e -t bear:e2e .

# a named build (data-build on <html>, __BUILD_ID__; letters, digits, '.', '_' and '-')
docker buildx build --load --platform linux/amd64 --build-arg BUILD_MODE=e2e --build-arg BEAR_BUILD_ID=v2 -t bear:e2e-v2 .
```

Build arguments:

| Arg | Default | Meaning |
|---|---|---|
| `BUILD_MODE` | `production` | `production` or `e2e`; passed to `pnpm build --mode` and to check-dist |
| `BEAR_BUILD_ID` | `dev` | the build id read by `vite.config.ts`; declared just before the build `RUN`, so the `pnpm install` layer stays cached across ids |

The `web` stage sets `ARG BUILDKIT_SBOM_SCAN_STAGE=true`, so a build with `--sbom=true` (the release workflow, plan §9) also
scans `node_modules` and `dist`, not only the final image (plan §9, SBOM scope). The Silero ONNX is not needed: the
extracted `weights.bin` is committed, and the parity check runs in CI, not in the image.

`.dockerignore` keeps `node_modules`, every `dist*` dir, `.git`, test and coverage output, `.cache`, `docs/research`
and `server/dist` out of the build context.

## Run

The production run flags (plan §4.8.2). The image needs no writable path, capability or extra process:

```sh
docker run -d --name bear \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --user 65532:65532 --pids-limit 64 --memory 64m \
  -p 8080:8080 bear:local
```

Checks (the CI `image-build` job runs the same):

```sh
curl -sI localhost:8080/                                 # 200 with the CSP and the other headers.json headers
docker exec bear /bearserve -probe                       # GETs 127.0.0.1:8080/healthz; exits 0 on 204
docker diff bear                                         # empty: the server writes nothing
docker image inspect bear:local --format '{{.Config.User}}'   # 65532:65532
```

`/bearserve -probe` is the compose healthcheck (distroless has no shell or curl):

```yaml
healthcheck:
  test: ['CMD', '/bearserve', '-probe']
```

## Base-image digests

Each `FROM` pins `<image>:<tag>@sha256:<index digest>`: the multi-arch image index, which is what a cross-platform
`FROM` needs. Resolve a digest with:

```sh
docker buildx imagetools inspect node:24.21.0-alpine3.24   # the "Digest:" line
```

Dependabot (`docker` ecosystem in `.github/dependabot.yml`) proposes digest and tag bumps weekly. Rebuild promptly for
Go security releases.
