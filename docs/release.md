# Releases

A `v*.*.*` tag publishes the image to GHCR as `ghcr.io/chethan123/talking-bear`, for `linux/amd64` and
`linux/arm64`, with BuildKit provenance and an SBOM attached. The workflow is
[`.github/workflows/release.yml`](../.github/workflows/release.yml) (plan §9). The image itself is described in
[`image.md`](image.md).

## What a tag runs

| Job | Token | What it does |
|---|---|---|
| `ci` | `contents: read` | the whole of [`ci.yml`](../.github/workflows/ci.yml), called as a reusable workflow: verify, coverage, go, the image jobs and e2e, on the tagged commit |
| `publish` (needs `ci`) | `contents: read`, `packages: write` | the steps below; the only job in any workflow that can push packages |

Neither job runs when a `v*.*.*` tag is deleted (GitHub sends a push event for the deletion too).

`publish`, in order:

0. Checks the tag format (see [How to tag](#how-to-tag)) and that the tagged commit is on `main`, and fails, before
   anything is built or pushed, if either check doesn't hold.
1. Sets up QEMU (arm64 only) and Buildx. QEMU only runs the arm64 image for the smoke test: both build stages run on
   the build platform and Go cross-compiles.
2. Computes the image tags and OCI labels with `docker/metadata-action`.
3. **arm64 smoke, before any push:** builds `linux/arm64` with `--load` as `bear:arm64`, runs it under QEMU with the
   production flags ([`image.md`](image.md#run)), waits for `/bearserve -probe`, and runs
   `bash scripts/check-headers.sh http://localhost:8080`. A failure here stops the release before anything is
   pushed.
4. Logs in to `ghcr.io` with the job's `GITHUB_TOKEN`.
5. Builds and pushes `linux/amd64,linux/arm64` with `provenance: mode=max` and `sbom: true`. It uses the same build
   args as the smoke build, so it reuses those layers: the arm64 image it pushes has exactly the layers that were
   smoke-tested.
6. Writes the image digest and tags to the job summary.

Both builds use `BUILD_MODE=production` and `BEAR_BUILD_ID=<version>`, so the released `index.html` carries
`data-build="1.2.3"`.

The release builds read only their own BuildKit cache, `type=gha,scope=release`, which pull request and `main` runs
never write (plan §9, caching in a privileged workflow). A tag run can restore caches its own ref wrote and caches
`main` wrote; no `main` or pull request workflow writes `scope=release`, so the release reads only layers an earlier
attempt of the same tag wrote. Each new tag therefore starts cold (a few minutes), then the push reuses the smoke
build's layers.

## How to tag

From an up-to-date `main` whose CI is green:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The tag must point at a commit on `main` (the merged, reviewed history): `publish` checks that the tagged commit is
an ancestor of `origin/main` and refuses any other commit before it builds or logs in. That check catches mistakes,
such as tagging a local or feature-branch commit. It can't stop someone with write access who tags a commit that
also edits `release.yml`, because GitHub runs the workflow file from the tagged commit. The real control for that is
a **tag ruleset** that restricts creating `v*` tags to the maintainer (repository **Settings → Rules → Rulesets**).
Whether to add one is the repo owner's decision; rulesets on a private repository may need a paid plan.

The tag must be `v<major>.<minor>.<patch>`, optionally with a pre-release suffix such as `-rc.1`, with no leading
zeros in the three numbers and no `+build` suffix (metadata-action would drop it and overwrite `1.2.3`). The
workflow's first step rejects any other tag, so nothing is pushed for it. Git tag `v1.2.3` gives the image tags
`1.2.3` and `1.2`. There is no `latest` tag: the monorepo pins by version and digest. A pre-release tag such as
`v1.3.0-rc.1` gives only `1.3.0-rc.1` (`docker/metadata-action` doesn't move `1.3` for a pre-release).

Follow the run under **Actions → Release**. If `ci` or the arm64 smoke fails, nothing is pushed: fix it on `main`
and tag the next patch version. Re-running a failed `publish` job with **Re-run failed jobs** is fine; it pushes the
same tags again, with a new digest; pin the digest from the job summary of the last successful run. Don't re-run an
older tag's publish after a newer patch has shipped: it moves the `X.Y` tag back.

Releases run one at a time, in the order the tags were pushed (`concurrency: release`), so two patch tags pushed close
together can't finish out of order and move `X.Y` back. While one release runs, GitHub keeps at most one more
waiting: if a third tag arrives, it may cancel the waiting run of the older tag. That is fine, because the newer tag
carries `X.Y`. The cancelled tag's own `X.Y.Z` image is then not published; the newer patch supersedes it.

## One-time step after the first push: make the package public

Decision Q6 (plan §12): the package is **public**, while the repo stays private. A package first pushed from a
private repo starts out private, and plan §9 knows of no supported API for user-owned packages, so this is a
one-time manual step after the first release:

1. Open the package: GitHub → your profile → **Packages** → `talking-bear` (or
   `https://github.com/users/chethan123/packages/container/package/talking-bear`).
2. **Package settings** → **Danger Zone** → **Change visibility** → **Public**, and confirm with the package name.

The image's `org.opencontainers.image.source=https://github.com/chethan123/talking-bear` label links the package to
this repo. The host then pulls without credentials. If a later release's push is refused, check that the package's
**Package settings** → **Manage Actions access** lists this repository with the **Write** role.

## Pull by digest

The `publish` job summary prints the digest of the multi-arch image index, for example:

```text
digest: sha256:0123…
```

Pin that digest; Docker picks the right platform from the index:

```sh
docker pull ghcr.io/chethan123/talking-bear@sha256:<digest>
```

To look up the digest of a version later, or to check the platforms:

```sh
docker buildx imagetools inspect ghcr.io/chethan123/talking-bear:0.1.0
```

## Provenance and SBOM

The pushed index carries a BuildKit provenance attestation and an SPDX SBOM per platform. Inspect them with:

```sh
docker buildx imagetools inspect ghcr.io/chethan123/talking-bear:0.1.0 --format '{{ json .Provenance }}'
docker buildx imagetools inspect ghcr.io/chethan123/talking-bear:0.1.0 --format '{{ json .SBOM }}'
```

- **Provenance is `mode=max`.** It embeds the build materials in the public image: the repo URL, the commit, the
  Dockerfile and the build args. None of that is secret here. If you'd rather not publish them, change
  `provenance: mode=max` to `provenance: mode=min` in `release.yml`.
- **SBOM scope.** The `web` stage sets `ARG BUILDKIT_SBOM_SCAN_STAGE=true`, so the SBOM also covers `node_modules`
  and the built bundle, not only the final distroless image and its Go binary ([`image.md`](image.md)).
- **No artifact attestations.** `actions/attest` needs GitHub Enterprise Cloud on a private repo, so the release
  relies on the BuildKit provenance and SBOM above. Revisit this if the repo becomes public.

## Pinned versions

Every action in `release.yml` is pinned by commit SHA with its tag in a comment, as in `ci.yml`; Dependabot's
`github-actions` entry bumps them. A Dependabot bump of an action used only in `release.yml` is first exercised by
the next tag; check that run's publish log.

Two images run privileged in the `publish` job, and two more shape what is built and attested, so all four are
pinned by tag and digest:

- the QEMU `binfmt` image that `docker/setup-qemu-action` runs (its `image` input);
- the BuildKit daemon image that `docker/setup-buildx-action` starts, which builds and pushes every layer (its
  `driver-opts: image=…` input; buildx's default is the mutable `moby/buildkit:buildx-stable-1`);
- the Dockerfile frontend, in the `# syntax=` line of the [`Dockerfile`](../Dockerfile) (the floating
  `docker/dockerfile:1` would pull whatever is newest before each build);
- the SBOM generator, in the push step's `sbom: generator=…` input (the default is the mutable
  `docker/buildkit-syft-scanner:stable-1`).

Don't rely on Dependabot for these pins; to bump one, resolve the new tag's index digest and update the pin:

```sh
docker buildx imagetools inspect docker.io/tonistiigi/binfmt:<qemu-vX.Y.Z>       # the "Digest:" line
docker buildx imagetools inspect moby/buildkit:<vX.Y.Z>                          # the "Digest:" line
docker buildx imagetools inspect docker/dockerfile:<X.Y.Z>                       # the "Digest:" line
docker buildx imagetools inspect docker/buildkit-syft-scanner:<X.Y.Z>            # the "Digest:" line
```
