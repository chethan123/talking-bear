# talking-bear

A client-side-only, installable, offline web app. You talk to Juni, an original bear character, and Juni repeats what you said in a high "cub" voice while its mouth moves in time. You can also poke, pet and tickle Juni to get reactions.

- **Privacy:** no backend, accounts or analytics; audio never leaves the device.
- **Targets:** Android Chrome first, desktop Chrome second.
- **Audience:** family-friendly, ages 4+.

## Status

Planning only; no application code yet. The implementation plan is in [`docs/plan.md`](docs/plan.md). It covers the architecture, researched decisions with sources, risks and the experiments that settle them, milestones M1–M8, the dependency list, and the CI and container-image outline.

## Deployment

CI publishes a small, non-root static-file-server image to `ghcr.io/chethan123/talking-bear:<version>`. See [§4.8](docs/plan.md#48-image-serving-and-headers) and [§9](docs/plan.md#9-ci-outline) of the plan.

## Licence

MIT. See [`LICENSE`](LICENSE).
