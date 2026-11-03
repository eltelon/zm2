#!/usr/bin/env bash
# Materialize only tracked production source and explicit test inputs.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
[[ $# == 1 && -n "$1" ]] || { printf 'Usage: build-context.sh EMPTY_DIRECTORY\n' >&2; exit 1; }
DEST="$1"
mkdir -p -- "$DEST"
[[ -z "$(find "$DEST" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
  printf 'Build context must be empty\n' >&2; exit 1;
}
# Git supplies filenames, not .git metadata. Modified tracked contents are used.
# New production files must be staged before running this harness.
git -C "$ROOT" ls-files -z -- bin lib index.js constants.js paths.js package.json package-lock.json \
  ':(exclude)**/.env*' ':(exclude)**/.npmrc' ':(exclude)**/node_modules/**' \
  | tar -C "$ROOT" --null -T - -cf - | tar -C "$DEST" -xf -
mkdir -p "$DEST/test/systemd" "$DEST/test/fixtures/systemd-express" \
  "$DEST/test/fixtures/update-node" "$DEST/test/e2e/systemd"
for file in package.json package-lock.json server.js; do
  cp "$ROOT/test/fixtures/systemd-express/$file" "$DEST/test/fixtures/systemd-express/"
done
for file in stable.js fail-on-target.js; do
  cp "$ROOT/test/fixtures/update-node/$file" "$DEST/test/fixtures/update-node/"
done
for file in update-node.sh compose-scenarios.sh; do
  cp "$ROOT/test/e2e/systemd/$file" "$DEST/test/e2e/systemd/"
done
cp "$ROOT/test/systemd/Dockerfile" "$ROOT/test/systemd/Dockerfile.dockerignore" "$DEST/test/systemd/"
# Legacy and BuildKit both have a root ignore file; neither sees the checkout.
cp "$ROOT/test/systemd/Dockerfile.dockerignore" "$DEST/.dockerignore"
