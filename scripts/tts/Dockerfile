# espeak-ng for the one-off TTS regression corpus (T39, issue #50; plan §7 M2 and §8 "Tools"). It is never a CI
# dependency and never bundled; espeak-ng is GPL-3.0, and its output is generally not covered by the GPL (plan §11).
#
#   docker build -t talking-bear-espeak-ng scripts/tts
#   node scripts/gen-tts.ts --docker talking-bear-espeak-ng
#
# The pins are unverified: resolved 2026-10-01: digest from registry-1.docker.io; package version from secondary
# sources because the Debian archive was unreachable from the agent sandbox; the image has not been built. Verify on
# first `docker build` (`docker run --rm --entrypoint dpkg <image> -s espeak-ng` must report 1.52.0+dfsg-5).
# The base is the debian:trixie-slim multi-arch index (tag pushed 2026-09-19). libespeak-ng1 and espeak-ng-data are
# pinned to the same version as espeak-ng, so the whole espeak-ng build is fixed.
#
# deb.debian.org serves only the current version of each suite. If a trixie point release replaces 1.52.0+dfsg-5 and
# apt can't find it, point apt at the snapshot archive of the resolution date instead of bumping the pin:
#   rm /etc/apt/sources.list.d/debian.sources
#   echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261001T000000Z trixie main' > /etc/apt/sources.list.d/snapshot.list
#
# espeak-ng output differs between versions: regenerate the whole corpus with one build (test/corpus/PROVENANCE.md
# records which build made the committed files).
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    espeak-ng=1.52.0+dfsg-5 \
    libespeak-ng1=1.52.0+dfsg-5 \
    espeak-ng-data=1.52.0+dfsg-5 \
  && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["espeak-ng"]
