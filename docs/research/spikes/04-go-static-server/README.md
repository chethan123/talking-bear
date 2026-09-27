# 04 — Go static server prototype

This is the prototype behind plan §4.8.1: a stdlib-only server that embeds the built PWA and never writes to disk.

It covers:

- `//go:embed all:dist`. The `all:` prefix is needed because Rolldown emits `_`-prefixed chunks.
- An explicit MIME map, including `application/manifest+json` and an exact `application/wasm`.
- Per-path `Cache-Control`: immutable `assets/`, `no-cache` for the shell, `sw.js` and the manifest, and `no-store` for errors.
- Security headers on every response.
- Precompressed `.br`/`.gz` variants chosen by `Accept-Encoding`, honouring `q=0`.
- Content-hash ETags.
- `http.ServeContent` handling 304/206/HEAD.
- 404/405 handling, `/healthz`, and a `-probe` flag for distroless health checks.

**Verified with curl** in the research sandbox:

- 200 with brotli and correct headers;
- 304 on `If-None-Match`, keeping the security headers;
- 206 on `Range` with `Accept-Encoding: identity`;
- gzip chosen when `br;q=0`;
- 404 with `no-store`;
- 405 on POST.

`go vet` and `go build` pass (Go 1.24.7).

## Run

```sh
mkdir -p dist && cp -r <built dist>/* dist/   # the embed needs a dist/ directory at build time
go run . -addr :8080
curl -sSI -H 'Accept-Encoding: br' localhost:8080/
```

## Known gaps

These were found in review and are fixed in the plan, not here:

- Variant ETags must keep the `.br`/`.gz` suffix **inside** the quotes.
- The header table isn't driven from `headers.json` yet.
- There is no 416 (bad Range) test.
- `GOMEMLIMIT` isn't set.

The production server (M7) starts from this file.
