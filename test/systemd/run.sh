#!/usr/bin/env bash
# Privileged integration: dedicated disposable Colima endpoint ONLY.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
CONTEXT="${ZM2_SYSTEMD_CONTEXT:-colima-zm2-systemd-test}"
EXPECTED_SOCKET="unix://${HOME}/.colima/zm2-systemd-test/docker.sock"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

[[ "${ZM2_SYSTEMD_E2E:-}" == 1 ]] || fail 'Set ZM2_SYSTEMD_E2E=1 to authorize privileged sandbox tests'
[[ "$CONTEXT" == colima-zm2-systemd-test ]] || fail 'Only context colima-zm2-systemd-test is allowed'
[[ -z "${DOCKER_HOST:-}" ]] || fail 'Unset DOCKER_HOST; remote/ambient endpoints are forbidden'
[[ -z "${DOCKER_CONTEXT:-}" || "$DOCKER_CONTEXT" == "$CONTEXT" ]] || fail 'Unset conflicting DOCKER_CONTEXT'
[[ "${1:-}" == '' || ( "$1" == --preflight && $# == 1 ) ]] || fail 'Usage: run.sh [--preflight]'
command -v docker >/dev/null || fail 'Docker CLI is required'
endpoint="$(docker --context "$CONTEXT" context inspect "$CONTEXT" --format '{{.Endpoints.docker.Host}}')"
[[ "$endpoint" == "$EXPECTED_SOCKET" ]] || fail "Unexpected Docker endpoint; require disposable socket $EXPECTED_SOCKET"
backend="$(docker --context "$CONTEXT" info --format '{{.OSType}} {{.CgroupVersion}} {{.Architecture}}')"
[[ "$backend" == 'linux 2 '* ]] || fail "Linux cgroups v2 required, got: $backend"
docker --context "$CONTEXT" compose version --short
printf 'Preflight OK: context=%s backend=%s\n' "$CONTEXT" "$backend"
[[ "${1:-}" != --preflight ]] || exit 0

parent="${ZM2_SYSTEMD_RESULTS:-${TMPDIR:-/tmp}}"
mkdir -p -- "$parent"
RESULTS="$(mktemp -d "$parent/zm2-systemd-e2e.XXXXXX")"
PROJECT="$(basename "$RESULTS" | tr '[:upper:].' '[:lower:]-')"
export ZM2_SYSTEMD_BUILD_CONTEXT="$RESULTS/build-context"
KEEP="${ZM2_SYSTEMD_KEEP:-0}"
[[ "$KEEP" == 0 || "$KEEP" == 1 ]] || fail 'ZM2_SYSTEMD_KEEP must be 0 or 1'
CID=''
STARTED=0
compose() { docker --context "$CONTEXT" compose -f "$ROOT/test/systemd/compose.yaml" -p "$PROJECT" "$@"; }

collect() {
  local failed=0
  if [[ -z "$CID" && "$STARTED" == 1 ]]; then
    CID="$(compose ps -a -q sandbox 2>/dev/null)" || true
  fi
  [[ -n "$CID" ]] || return 0
  docker --context "$CONTEXT" logs "$CID" > "$RESULTS/container.log" 2>&1 || true
  docker --context "$CONTEXT" inspect "$CID" --format \
    'Id={{.Id}} Image={{.Image}} Privileged={{.HostConfig.Privileged}} Cgroupns={{.HostConfig.CgroupnsMode}} Mounts={{json .Mounts}} Ports={{json .NetworkSettings.Ports}}' \
    > "$RESULTS/container-identity.txt" 2>&1 || failed=1
  compose exec -T sandbox systemctl list-units --all --no-pager > "$RESULTS/units.txt" 2>&1 || true
  compose exec -T sandbox journalctl --no-pager -n 500 > "$RESULTS/journal.txt" 2>&1 || true
  docker --context "$CONTEXT" cp "$CID:/var/lib/zm2-evidence/." "$RESULTS/" > "$RESULTS/copy-evidence.log" 2>&1 || failed=1
  return "$failed"
}

finish() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if ! collect; then
    printf 'FAIL: required evidence collection failed\n' >&2
    [[ "$status" != 0 ]] || status=1
  fi
  if [[ "$KEEP" == 1 && "$status" != 0 ]]; then
    printf 'Retained failed project %s, container %s\n' "$PROJECT" "$CID"
    printf 'Cleanup: docker --context %s compose -f %q -p %q down --volumes\n' "$CONTEXT" "$RESULTS/compose.yaml" "$PROJECT"
  elif [[ "$STARTED" == 1 ]]; then
    compose down --volumes --remove-orphans > "$RESULTS/teardown.log" 2>&1
    local clean_status=$?
    if [[ "$clean_status" != 0 ]]; then
      printf 'FAIL: sandbox cleanup failed; inspect %s/teardown.log\n' "$RESULTS" >&2
      [[ "$status" != 0 ]] || status=$clean_status
    fi
  fi
  printf '%s\n' "$status" > "$RESULTS/exit-code.txt"
  printf 'Results: %s (exit %s)\n' "$RESULTS" "$status"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'project=%s\ncontext=%s\nbackend=%s\n' "$PROJECT" "$CONTEXT" "$backend" > "$RESULTS/run.txt"
git -C "$ROOT" rev-parse HEAD >> "$RESULTS/run.txt"
git -C "$ROOT" status --short >> "$RESULTS/run.txt"
git -C "$ROOT" diff --binary HEAD -- bin lib index.js constants.js paths.js \
  package.json package-lock.json test/systemd test/e2e/systemd \
  test/fixtures/systemd-express test/fixtures/update-node > "$RESULTS/source.patch"
# Untracked harness sources are also retained for runs before their first commit.
mkdir "$RESULTS/harness-source"
cp -R "$ROOT/test/systemd" "$RESULTS/harness-source/"
cp "$ROOT/test/e2e/systemd/compose-scenarios.sh" "$RESULTS/harness-source/"
mkdir "$RESULTS/harness-source/express"
cp "$ROOT/test/fixtures/systemd-express/"{package.json,package-lock.json,server.js} \
  "$RESULTS/harness-source/express/"
bash "$ROOT/test/systemd/build-context.sh" "$ZM2_SYSTEMD_BUILD_CONTEXT"
compose config > "$RESULTS/compose.yaml"
printf 'Building sandbox; logs: %s/build.log\n' "$RESULTS"
compose build > "$RESULTS/build.log" 2>&1
STARTED=1
compose up -d > "$RESULTS/up.log" 2>&1
CID="$(compose ps -q sandbox)"
[[ -n "$CID" ]] || fail 'Compose did not create a running sandbox'

wait_init() {
  local i state
  for ((i=0; i<90; i++)); do
    state="$(compose exec -T sandbox systemctl is-system-running 2>/dev/null || true)"
    case "$state" in running|degraded) return 0 ;; esac
    sleep 1
  done
  fail 'systemd did not finish starting within 90 seconds'
}

run_logged() {
  local name="$1" status
  shift
  printf 'Scenario: %s\n' "$name"
  if "$@" 2>&1 | tee "$RESULTS/$name.log"; then status=0; else status=$?; fi
  printf '%s\n' "$status" > "$RESULTS/$name.exit-code.txt"
  return "$status"
}

phase() {
  local evidence_dir=/var/lib/zm2-evidence
  if [[ $# -gt 1 ]]; then evidence_dir="$evidence_dir/$2"; fi
  run_logged "${2:-$1}" compose exec -T -e ZM2_SYSTEMD_E2E=1 \
    -e EVIDENCE_DIR="$evidence_dir" sandbox \
    timeout 240s bash /opt/zm2/test/e2e/systemd/compose-scenarios.sh "$1"
}

wait_init
compose exec -T sandbox bash -c \
  'uname -a; systemd --version; "$CLI_NODE" --version; "$NVM_DIR/versions/node/v$ZM2_NODE_TARGET/bin/node" --version; . "$NVM_DIR/nvm.sh"; nvm --version; cd /opt/zm2/test/fixtures/systemd-express; npm ls --depth=0' \
  > "$RESULTS/versions.txt" 2>&1
phase backend
phase lifecycle
phase prepare-boot
printf 'Stopping and starting the SAME container (not a Linux kernel reboot)\n'
compose stop sandbox > "$RESULTS/stop.log" 2>&1
compose start sandbox > "$RESULTS/start.log" 2>&1
[[ "$(compose ps -q sandbox)" == "$CID" ]] || fail 'Sandbox was recreated instead of restarted'
wait_init
phase backend backend-after-boot
phase verify-boot
phase cleanup cleanup-before-update
run_logged update-node compose exec -T sandbox bash -c \
  'test_home="$(mktemp -d /var/lib/zm2-update-node-e2e.XXXXXX)"; trap '\''rmdir "$test_home"'\'' EXIT; ZM2_UPDATE_NODE_E2E=1 ZM2_HOME="$test_home" timeout 240s bash /opt/zm2/test/e2e/systemd/update-node.sh'
phase no-rollback
phase cleanup cleanup-final
printf 'All real-systemd scenarios passed\n'
