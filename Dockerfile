# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# Talking Bear image (plan §4.8.2, issue #106). Build and run commands: docs/image.md.
# Base-image index digests resolved 2026-10-09 with `docker buildx imagetools inspect <image>:<tag>`;
# Dependabot (.github/dependabot.yml, docker) keeps them current.
# BUILD_MODE=e2e builds dist with test hooks for the CI e2e image
ARG BUILD_MODE=production

# node:24.21.0-alpine3.24 index digest, resolved 2026-10-09
FROM --platform=$BUILDPLATFORM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS web
WORKDIR /src
# include node_modules/dist in the SBOM, not just the final image
ARG BUILDKIT_SBOM_SCAN_STAGE=true
RUN npm install -g pnpm@12.6.0 --ignore-scripts
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
# .dockerignore excludes node_modules, dist*, .git, test-results
COPY . .
# the shipped bytes are the checked bytes: check-dist and size-limit run before precompression
# Both ARGs are declared here, not at the top of the stage: an ARG changes the cache key of every RUN after it,
# so the npm and pnpm install layers stay cached across build modes and build ids.
ARG BUILD_MODE
# the build id: vite.config.ts reads BEAR_BUILD_ID from the next RUN's environment
ARG BEAR_BUILD_ID=dev
RUN pnpm build --mode "$BUILD_MODE" && node scripts/check-dist.mjs dist "$BUILD_MODE" \
 && pnpm size-limit && node scripts/precompress.mjs dist

# golang:1.27.1-alpine3.24 index digest, resolved 2026-10-09
FROM --platform=$BUILDPLATFORM golang:1.27.2-alpine3.24@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS server
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY server/ ./
COPY --from=web /src/dist ./dist
# without -tags noembed: dist exists here, so go vet and go test cover the embedding build
RUN go vet ./... && go test ./... && \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -buildid=" -o /out/bearserve .

# gcr.io/distroless/static-debian13:nonroot index (multi-arch) digest, resolved 2026-10-09
FROM gcr.io/distroless/static-debian13:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99
ENV GOMEMLIMIT=48MiB
COPY --from=server /out/bearserve /bearserve
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/bearserve"]
