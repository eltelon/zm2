#!/usr/bin/env bash
#
# Real Linux/systemd integration scenarios for the ZM2 Compose sandbox.
#
# This script is intended to run *inside* the disposable privileged container
# built by test/systemd/. It never talks to Docker and never manages the
# container lifecycle; the host runner invokes one phase at a time.
#
# Phases:
#   backend       guards + real PID 1/systemctl/journald/cgroup checks
#   lifecycle     Express start/stop/start, restart, enabled state, logs, modes,
#                 single-instance counts and legacy template rejection
#   prepare-boot  create enabled + stopped apps and snapshot boot evidence
#   verify-boot   assert systemd auto-start and preserved files after restart
#   no-rollback   update-node --no-rollback keeps target config on failure
#   cleanup       delete only the apps created by this script
#
# The host runner stops and starts the same container between prepare-boot and
# verify-boot. Evidence is written below $EVIDENCE_DIR (default
# /var/lib/zm2-evidence) and is intentionally free of full environment dumps.
#
# Opt-in and safety:
#   ZM2_SYSTEMD_E2E=1
#   Linux, root, PID 1 == systemd, responsive systemctl
#
# Image contract (overridable for local experiments):
#   NVM_DIR=/opt/nvm
#   ZM2_NODE_OLD=22.14.0
#   ZM2_NODE_TARGET=24.0.0
#   CLI_NODE=/opt/nvm/versions/node/v22.14.0/bin/node
#   ZM2_REPO=/opt/zm2
#   ZM2_HOME=/var/lib/zm2-test
#   EVIDENCE_DIR=/var/lib/zm2-evidence
#
# All systemd resources created here are named zm2-compose-e2e-*.
#
set -Eeuo pipefail

NVM_DIR="${NVM_DIR:-/opt/nvm}"
ZM2_NODE_OLD="${ZM2_NODE_OLD:-22.14.0}"
ZM2_NODE_TARGET="${ZM2_NODE_TARGET:-24.0.0}"
ZM2_REPO="${ZM2_REPO:-/opt/zm2}"
ZM2_HOME="${ZM2_HOME:-/var/lib/zm2-test}"
EVIDENCE_DIR="${EVIDENCE_DIR:-/var/lib/zm2-evidence}"
CLI_NODE="${CLI_NODE:-}"

ZM2_BIN="$ZM2_REPO/bin/zm2"
FIXTURE_DIR="$ZM2_REPO/test/fixtures/systemd-express"
FIXTURE="$FIXTURE_DIR/server.js"
STABLE_DIR="$ZM2_REPO/test/fixtures/update-node"
STABLE_FIXTURE="$STABLE_DIR/stable.js"

ENV_DIR="/etc/zm2/env"
UNIT_DIR="/etc/systemd/system"
WANTS_DIR="$UNIT_DIR/multi-user.target.wants"

APP_PREFIX="compose-e2e"
SVC_PREFIX="zm2-compose-e2e"

APP_LIFECYCLE="$APP_PREFIX-lifecycle"
SVC_LIFECYCLE="$SVC_PREFIX-lifecycle"
PORT_LIFECYCLE=3100

APP_BOOT_ENABLED="$APP_PREFIX-boot-enabled"
SVC_BOOT_ENABLED="$SVC_PREFIX-boot-enabled"
PORT_BOOT_ENABLED=3101

APP_BOOT_STOPPED="$APP_PREFIX-boot-stopped"
SVC_BOOT_STOPPED="$SVC_PREFIX-boot-stopped"
PORT_BOOT_STOPPED=3102

APP_NR_FAIL="$APP_PREFIX-norollback-fail"
SVC_NR_FAIL="$SVC_PREFIX-norollback-fail"
PORT_NR_FAIL=3103

APP_NR_OK="$APP_PREFIX-norollback-ok"
SVC_NR_OK="$SVC_PREFIX-norollback-ok"
PORT_NR_OK=3104

APP_NR_STOPPED="$APP_PREFIX-norollback-stopped"
SVC_NR_STOPPED="$SVC_PREFIX-norollback-stopped"
PORT_NR_STOPPED=3105

APP_DELETE="$APP_PREFIX-delete"
SVC_DELETE="$SVC_PREFIX-delete"
PORT_DELETE=3106

APP_SINGLE_FLAG="$APP_PREFIX-single-flag"
SVC_SINGLE_FLAG="$SVC_PREFIX-single-flag"
PORT_SINGLE_FLAG=3107

APP_SINGLE_MAX="$APP_PREFIX-single-max"
SVC_SINGLE_MAX="$SVC_PREFIX-single-max"
PORT_SINGLE_MAX=3108

APP_SINGLE_ECO="$APP_PREFIX-single-ecosystem"
SVC_SINGLE_ECO="$SVC_PREFIX-single-ecosystem"
PORT_SINGLE_ECO=3109

APP_LEGACY="$APP_PREFIX-legacy"
SVC_LEGACY="$SVC_PREFIX-legacy"
LEGACY_UPDATE_HOME=""

CONCURRENT_COUNT=3
CONCURRENT_APPS=()
CONCURRENT_SVCS=()
for ((i = 1; i <= CONCURRENT_COUNT; i++)); do
  CONCURRENT_APPS+=("$APP_PREFIX-concurrent-$i")
  CONCURRENT_SVCS+=("$SVC_PREFIX-concurrent-$i")
done

NOROLLBACK_HOME="$ZM2_HOME/compose-e2e-norollback"
BOOT_SNAPSHOT="$EVIDENCE_DIR/boot-snapshot.json"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM:-0}"

PHASE=""
TMP_DIR=""
OLD_VERSION=""
TARGET_VERSION=""
OLD_NODE=""
TARGET_NODE=""
OLD_BIN=""
TARGET_BIN=""
DEFAULT_PATH=""
REAL_SYSTEMCTL=""

info() {
  printf 'INFO: %s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

ok() {
  printf 'OK: %s\n' "$*"
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

enable_err_trap() {
  trap 'printf "ERROR: command failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
}

normalize_version() {
  local input="$1"

  if [[ ! "$input" =~ ^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    return 1
  fi

  printf '%s' "${input#v}"
}

unit_path_for() {
  printf '%s/%s.service' "$UNIT_DIR" "$1"
}

env_path_for() {
  printf '%s/%s.env' "$ENV_DIR" "$1"
}

state_file_for() {
  printf '%s/state.json' "$1"
}

# ---------------------------------------------------------------------------
# Guards (read-only; run before any mutation)
# ---------------------------------------------------------------------------

require_e2e_environment() {
  local missing=()
  local nvm_mode
  local actual
  local system_state
  local cgroup
  local failed_unit
  local i

  if [[ "${ZM2_SYSTEMD_E2E:-}" != "1" ]]; then
    fail "Refusing to run: set ZM2_SYSTEMD_E2E=1 to opt in to this destructive integration test"
  fi

  [[ "$(uname -s)" == "Linux" ]] \
    || fail "Refusing to run: requires Linux with systemd (found $(uname -s))"

  [[ "$(id -u)" == "0" ]] \
    || fail "Refusing to run: requires root privileges"

  [[ -r /proc/1/comm ]] || fail "Refusing to run: /proc/1/comm is not readable"
  [[ "$(tr -d '\n' < /proc/1/comm)" == "systemd" ]] \
    || fail "Refusing to run: PID 1 is not systemd ($(tr -d '\n' < /proc/1/comm))"

  [[ -d /run/systemd/system ]] \
    || fail "Refusing to run: systemd is not running (/run/systemd/system is missing)"

  command -v systemctl >/dev/null 2>&1 \
    || fail "Refusing to run: systemctl is not available"
  REAL_SYSTEMCTL="$(command -v systemctl)"
  [[ "$REAL_SYSTEMCTL" == /* ]] \
    || fail "Refusing to run: systemctl is not an absolute path: $REAL_SYSTEMCTL"

  systemctl show --property=Version --value >/dev/null 2>&1 \
    || fail "Refusing to run: systemctl is not responding"

  [[ -d "$UNIT_DIR" && -w "$UNIT_DIR" ]] \
    || fail "Refusing to run: $UNIT_DIR is missing or not writable"
  [[ -w /etc ]] \
    || fail "Refusing to run: /etc is not writable (cannot create $ENV_DIR)"

  for i in curl journalctl ss sha256sum timeout realpath stat systemd-analyze; do
    command -v "$i" >/dev/null 2>&1 || missing+=("$i")
  done
  if [[ "${#missing[@]}" -gt 0 ]]; then
    fail "Refusing to run: missing required command(s): ${missing[*]}"
  fi

  [[ -n "${NVM_DIR:-}" ]] || fail "NVM_DIR is required"
  [[ "$NVM_DIR" == /* ]] || fail "NVM_DIR must be an absolute path: $NVM_DIR"
  [[ -d "$NVM_DIR" ]] || fail "NVM_DIR is not a directory: $NVM_DIR"
  [[ -f "$NVM_DIR/nvm.sh" && -r "$NVM_DIR/nvm.sh" ]] \
    || fail "trusted nvm.sh not found or not readable: $NVM_DIR/nvm.sh"
  nvm_mode="$(stat -Lc '%a' "$NVM_DIR/nvm.sh" 2>/dev/null || true)"
  if [[ -z "$nvm_mode" ]] || (( (8#$nvm_mode & 8#022) != 0 )); then
    fail "Refusing to source group/world-writable nvm.sh (mode ${nvm_mode:-unknown})"
  fi

  if ! OLD_VERSION="$(normalize_version "$ZM2_NODE_OLD")"; then
    fail "ZM2_NODE_OLD must be an exact major.minor.patch version: $ZM2_NODE_OLD"
  fi
  if ! TARGET_VERSION="$(normalize_version "$ZM2_NODE_TARGET")"; then
    fail "ZM2_NODE_TARGET must be an exact major.minor.patch version: $ZM2_NODE_TARGET"
  fi
  [[ "$OLD_VERSION" != "$TARGET_VERSION" ]] \
    || fail "ZM2_NODE_OLD and ZM2_NODE_TARGET must differ"

  OLD_NODE="$NVM_DIR/versions/node/v$OLD_VERSION/bin/node"
  TARGET_NODE="$NVM_DIR/versions/node/v$TARGET_VERSION/bin/node"
  OLD_BIN="$NVM_DIR/versions/node/v$OLD_VERSION/bin"
  TARGET_BIN="$NVM_DIR/versions/node/v$TARGET_VERSION/bin"
  DEFAULT_PATH="$OLD_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

  if [[ -z "$CLI_NODE" ]]; then
    CLI_NODE="$OLD_NODE"
  fi
  [[ "$CLI_NODE" == /* ]] || fail "CLI_NODE must be an absolute path: $CLI_NODE"
  [[ -x "$CLI_NODE" ]] || fail "CLI_NODE is missing or not executable: $CLI_NODE"

  actual="$("$CLI_NODE" --version 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$actual" == "v$OLD_VERSION" ]] \
    || fail "CLI_NODE must be the old runtime v$OLD_VERSION, got '${actual:-none}' from $CLI_NODE"

  actual="$("$OLD_NODE" --version 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$actual" == "v$OLD_VERSION" ]] \
    || fail "old runtime is missing or wrong: expected v$OLD_VERSION, got '${actual:-none}' at $OLD_NODE"

  [[ -f "$ZM2_BIN" ]] || fail "ZM2 CLI not found: $ZM2_BIN"
  [[ -f "$FIXTURE" ]] || fail "Express fixture not found: $FIXTURE"
  [[ -f "$STABLE_FIXTURE" ]] || fail "stable fixture not found: $STABLE_FIXTURE"

  [[ "$ZM2_HOME" == /* ]] || fail "ZM2_HOME must be an absolute path: $ZM2_HOME"
  [[ "$ZM2_HOME" != "/" ]] || fail "ZM2_HOME must not be /"
  [[ "$ZM2_HOME" != "/root/.zm2" && "$ZM2_HOME" != "/etc/.zm2" ]] \
    || fail "Refusing to use a production-looking ZM2 home: $ZM2_HOME"

  [[ "$EVIDENCE_DIR" == /* ]] || fail "EVIDENCE_DIR must be an absolute path: $EVIDENCE_DIR"

  # Wait briefly for systemd to finish starting. A degraded manager is accepted
  # only if it is diagnosed in the evidence, never silently ignored.
  system_state=""
  for ((i = 0; i < 60; i++)); do
    system_state="$(systemctl is-system-running 2>/dev/null || true)"
    case "$system_state" in
      running|degraded) break ;;
    esac
    sleep 0.5
  done
  case "$system_state" in
    running) ;;
    degraded)
      warn "systemd is degraded; failed units follow"
      systemctl --failed --no-legend --no-pager 2>/dev/null || true
      [[ "$PHASE" == cleanup ]] || fail "unexpected degraded systemd manager"
      while IFS= read -r failed_unit; do
        case "$failed_unit" in
          zm2-compose-e2e-*.service) ;;
          *) fail "unexpected failed backend unit: $failed_unit" ;;
        esac
      done < <(systemctl --failed --no-legend --plain --no-pager | awk '{print $1}')
      ;;
    *)
      fail "systemd is not ready (is-system-running: '${system_state:-unknown}')"
      ;;
  esac

  systemctl is-active --quiet systemd-journald.service \
    || fail "systemd-journald is not active"
  journalctl --no-pager -n 1 >/dev/null 2>&1 \
    || fail "journalctl is not usable"

  cgroup="$(systemctl show -p ControlGroup --value systemd-journald.service 2>/dev/null || true)"
  [[ -n "$cgroup" ]] \
    || fail "systemd-journald has no ControlGroup; cgroup management is not available"
  [[ -d "/sys/fs/cgroup$cgroup" ]] \
    || fail "cgroup path /sys/fs/cgroup$cgroup is missing; private cgroup namespace is not usable"

  if [[ -e "$TARGET_NODE" ]]; then
    actual="$("$TARGET_NODE" --version 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "$actual" == "v$TARGET_VERSION" ]] \
      || fail "target runtime is wrong: expected v$TARGET_VERSION, got '${actual:-none}' at $TARGET_NODE"
  else
    info "Target runtime v$TARGET_VERSION is not installed yet; update-node will install it"
  fi
}

setup_evidence() {
  mkdir -p "$EVIDENCE_DIR/$PHASE"
  mkdir -p "$ZM2_HOME"
  chmod 700 "$ZM2_HOME" 2>/dev/null || true

  TMP_DIR="$(mktemp -d "/tmp/zm2-compose-e2e-$PHASE.XXXXXX")"
  trap 'if [[ -n "${TMP_DIR:-}" ]]; then rm -rf -- "$TMP_DIR"; fi' EXIT

  {
    printf 'phase=%s\n' "$PHASE"
    printf 'run_id=%s\n' "$RUN_ID"
    printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$EVIDENCE_DIR/$PHASE/phase.txt"
}

# ---------------------------------------------------------------------------
# CLI invocation
# ---------------------------------------------------------------------------

run_zm2_home() {
  local home="$1"
  local timeout_s="$2"
  shift 2
  local path_value="$DEFAULT_PATH"

  env \
    -u OVER_HOME \
    -u PM2_STATE_FILE_PATH \
    -u PM2_DUMP_FILE_PATH \
    -u PM2_DUMP_BACKUP_FILE_PATH \
    -u PM2_CONF_FILE \
    -u PM2_MODULE_CONF_FILE \
    -u PM2_LOG_FILE_PATH \
    -u PM2_PID_FILE_PATH \
    -u PM2_RELOAD_LOCKFILE \
    -u PM2_DEFAULT_PID_PATH \
    -u PM2_DEFAULT_LOG_PATH \
    -u PM2_DEFAULT_MODULE_PATH \
    -u PM2_IO_ACCESS_TOKEN \
    -u PM2_INTERACTOR_LOG_FILE_PATH \
    -u PM2_INTERACTOR_PID_PATH \
    -u PM2_INTERACTION_CONF \
    -u PM2_DAEMON_RPC_PORT \
    -u PM2_DAEMON_PUB_PORT \
    -u PM2_INTERACTOR_RPC_PORT \
    -u PM2_PROGRAMMATIC \
    -u ZM2_PROGRAMMATIC \
    -u pm_id \
    -u PM2_SILENT \
    -u ZM2_SILENT \
    -u PM2_DEBUG \
    -u ZM2_DEBUG \
    -u DEBUG \
    -u NODE_OPTIONS \
    HOME="${HOME:-/root}" \
    ZM2_HOME="$home" \
    PM2_HOME="$home" \
    NVM_DIR="$NVM_DIR" \
    PATH="$path_value" \
    timeout "$timeout_s" "$CLI_NODE" "$ZM2_BIN" "$@"
}

run_zm2() {
  run_zm2_home "$ZM2_HOME" 120 "$@"
}

run_zm2_norollback() {
  run_zm2_home "$NOROLLBACK_HOME" 120 "$@"
}

# ---------------------------------------------------------------------------
# systemd / procfs / HTTP helpers
# ---------------------------------------------------------------------------

unit_active_state() {
  systemctl show -p ActiveState --value "$1.service" 2>/dev/null || true
}

unit_sub_state() {
  systemctl show -p SubState --value "$1.service" 2>/dev/null || true
}

unit_pid() {
  local value
  value="$(systemctl show -p MainPID --value "$1.service" 2>/dev/null || true)"
  printf '%s' "${value//[[:space:]]/}"
}

unit_enabled() {
  if systemctl is-enabled --quiet "$1.service"; then
    printf '1'
  else
    printf '0'
  fi
}

unit_exec_path() {
  local raw
  local value

  raw="$(systemctl show -p ExecStart --value "$1.service" 2>/dev/null || true)"
  value="$(printf '%s' "$raw" \
    | sed -n 's/.*path=\([^;]*\) *;.*/\1/p' \
    | head -n 1 \
    | sed 's/[[:space:]]*$//' || true)"

  if [[ "$value" == \"*\" ]]; then
    value="${value#\"}"
    value="${value%\"}"
  fi

  printf '%s' "$value"
}

wait_active() {
  local svc="$1"
  local attempts="${2:-150}"
  local i

  for ((i = 0; i < attempts; i++)); do
    if systemctl is-active --quiet "$svc.service"; then
      return 0
    fi
    sleep 0.2
  done

  fail "unit $svc did not become active"
}

wait_inactive() {
  local svc="$1"
  local attempts="${2:-150}"
  local i
  local state

  for ((i = 0; i < attempts; i++)); do
    state="$(unit_active_state "$svc")"
    if [[ "$state" == "inactive" || "$state" == "failed" ]]; then
      return 0
    fi
    sleep 0.2
  done

  fail "unit $svc did not become inactive (state: $(unit_active_state "$svc"))"
}

wait_pid_zero() {
  local svc="$1"
  local attempts="${2:-150}"
  local i
  local pid

  for ((i = 0; i < attempts; i++)); do
    pid="$(unit_pid "$svc")"
    if [[ "$pid" == "0" ]]; then
      return 0
    fi
    sleep 0.2
  done

  fail "unit $svc still has MainPID '$pid'"
}

wait_http() {
  local port="$1"
  local output="$2"
  local attempts="${3:-150}"
  local i

  for ((i = 0; i < attempts; i++)); do
    if curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$port/health" -o "$output" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done

  fail "HTTP health on port $port did not become ready"
}

assert_http_down() {
  local port="$1"
  local label="$2"

  if curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:$port/health" -o /dev/null 2>/dev/null; then
    fail "$label: HTTP is still available on port $port"
  fi
}

json_get() {
  local file="$1"
  local key="$2"

  "$CLI_NODE" -e '
    var fs = require("fs");
    var data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    var path = process.argv[2].split(".");
    var value = data;
    for (var i = 0; i < path.length; i++) {
      if (value === null || value === undefined) break;
      value = value[path[i]];
    }
    if (value === undefined) process.exit(2);
    if (value !== null && typeof value === "object") process.stdout.write(JSON.stringify(value));
    else process.stdout.write(String(value));
  ' "$file" "$key"
}

assert_health() {
  local file="$1"
  local expected_pid="$2"
  local expected_node="$3"
  local label="$4"
  local status
  local pid
  local node

  status="$(json_get "$file" status)" || fail "$label: health JSON has no status"
  pid="$(json_get "$file" pid)" || fail "$label: health JSON has no pid"
  node="$(json_get "$file" node)" || fail "$label: health JSON has no node"

  [[ "$status" == "ok" ]] || fail "$label: health status is '$status', expected ok"
  [[ "$pid" =~ ^[0-9]+$ ]] || fail "$label: health pid is not numeric: $pid"

  if [[ -n "$expected_pid" && "$pid" != "$expected_pid" ]]; then
    fail "$label: health pid $pid does not match systemd MainPID $expected_pid"
  fi
  if [[ -n "$expected_node" && "$node" != "$expected_node" ]]; then
    fail "$label: health node $node does not match expected $expected_node"
  fi
}

assert_proc_exe() {
  local pid="$1"
  local expected="$2"
  local label="$3"
  local actual
  local expected_real

  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 0 ]] \
    || fail "$label: invalid MainPID '$pid'"
  actual="$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)"
  [[ -n "$actual" ]] || fail "$label: cannot resolve /proc/$pid/exe"
  expected_real="$(realpath -m -- "$expected")"
  [[ "$actual" == "$expected_real" ]] \
    || fail "$label: /proc/$pid/exe is $actual, expected $expected_real"
}

assert_runtime() {
  local executable="$1"
  local version="$2"
  local label="$3"
  local actual

  [[ -f "$executable" && -x "$executable" ]] \
    || fail "$label: executable is missing or not executable: $executable"
  actual="$("$executable" --version 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$actual" == "v$version" ]] \
    || fail "$label: expected v$version, got '${actual:-none}'"
}

# ---------------------------------------------------------------------------
# File / unit / env assertions
# ---------------------------------------------------------------------------

sha256_file() {
  sha256sum -- "$1" | awk '{print $1}'
}

assert_dir_mode() {
  local label="$1"
  local expected="$2"
  local path="$3"
  local actual

  actual="$(stat -c '%a' -- "$path")"
  [[ "$actual" == "$expected" ]] \
    || fail "$label: expected mode $expected on $path, got $actual"
}

assert_file_mode() {
  local label="$1"
  local expected="$2"
  local path="$3"
  local actual

  actual="$(stat -c '%a' -- "$path")"
  [[ "$actual" == "$expected" ]] \
    || fail "$label: expected mode $expected on $path, got $actual"
}

assert_unit_contains() {
  local label="$1"
  local unit_path="$2"
  local expected="$3"

  [[ -f "$unit_path" ]] || fail "$label: unit file is missing: $unit_path"
  grep -Fq "$expected" "$unit_path" \
    || fail "$label: unit file is missing expected line '$expected'"
}

assert_unit_file_exec() {
  local label="$1"
  local unit_path="$2"
  local expected="$3"
  local line

  [[ -f "$unit_path" ]] || fail "$label: unit file is missing: $unit_path"
  line="$(grep -m1 '^ExecStart=' "$unit_path" || true)"
  [[ -n "$line" ]] || fail "$label: no ExecStart line in $unit_path"

  case "$line" in
    "ExecStart=$expected"|"ExecStart=$expected "*) ;;
    *) fail "$label: unit file ExecStart does not start with $expected: $line" ;;
  esac
}

assert_unit_exec() {
  local label="$1"
  local svc="$2"
  local expected="$3"
  local effective
  local expected_real

  effective="$(unit_exec_path "$svc")"
  [[ -n "$effective" ]] \
    || fail "$label: systemctl show did not expose an ExecStart path for $svc"
  expected_real="$(realpath -m -- "$expected")"
  [[ "$(realpath -m -- "$effective")" == "$expected_real" ]] \
    || fail "$label: effective ExecStart is $effective, expected $expected_real"
}

assert_env_contains() {
  local label="$1"
  local env_file="$2"
  local expected="$3"

  [[ -f "$env_file" ]] || fail "$label: environment file is missing: $env_file"
  grep -Fq "$expected" "$env_file" \
    || fail "$label: environment file is missing '$expected'"
}

assert_env_path_prefixed() {
  local label="$1"
  local env_file="$2"
  local expected_bin="$3"
  local path_lines
  local path_value
  local old_ifs
  local -a parts=()
  local part
  local count=0

  [[ -f "$env_file" ]] || fail "$label: environment file is missing: $env_file"

  path_lines="$(grep -c '^PATH=' "$env_file" || true)"
  [[ "$path_lines" == "1" ]] \
    || fail "$label: expected exactly one PATH line in $env_file, found $path_lines"

  path_value="$(grep -m1 '^PATH=' "$env_file" | cut -d= -f2- || true)"
  [[ -n "$path_value" ]] || fail "$label: empty PATH in $env_file"

  if [[ "$path_value" == \"*\" ]]; then
    path_value="${path_value#\"}"
    path_value="${path_value%\"}"
  fi

  old_ifs="$IFS"
  IFS=':'
  read -r -a parts <<< "$path_value"
  IFS="$old_ifs"

  [[ "${parts[0]:-}" == "$expected_bin" ]] \
    || fail "$label: PATH does not start with $expected_bin: $path_value"

  for part in "${parts[@]}"; do
    if [[ "$part" == "$expected_bin" ]]; then
      count=$((count + 1))
    fi
  done

  [[ "$count" -eq 1 ]] \
    || fail "$label: expected exactly one $expected_bin in PATH, found $count: $path_value"

  if grep -Eq '^PATH=.*\$PATH' "$env_file"; then
    fail "$label: PATH contains literal \$PATH: $env_file"
  fi
}

assert_env_modes() {
  local label="$1"
  local svc="$2"

  assert_dir_mode "$label environment directory" 700 "$ENV_DIR"
  assert_file_mode "$label environment file" 600 "$(env_path_for "$svc")"
}

assert_enabled_state() {
  local label="$1"
  local svc="$2"
  local expected="$3"
  local actual

  actual="$(unit_enabled "$svc")"
  [[ "$actual" == "$expected" ]] \
    || fail "$label: expected enabled=$expected for $svc, got enabled=$actual"
}

# ---------------------------------------------------------------------------
# StateStore helpers
# ---------------------------------------------------------------------------

state_get() {
  local home="$1"
  local svc="$2"
  local key="$3"

  "$CLI_NODE" -e '
    var fs = require("fs");
    var data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    var entry = (data.services || {})[process.argv[2]];
    if (!entry) {
      console.error("missing StateStore entry " + process.argv[2]);
      process.exit(2);
    }
    var value = entry[process.argv[3]];
    if (value === undefined) {
      console.error("missing StateStore key " + process.argv[3]);
      process.exit(3);
    }
    process.stdout.write(String(value));
  ' "$(state_file_for "$home")" "$svc" "$key"
}

state_has_service() {
  local home="$1"
  local svc="$2"

  [[ -f "$(state_file_for "$home")" ]] || return 1
  "$CLI_NODE" -e '
    var fs = require("fs");
    var data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.exit((data.services || {})[process.argv[2]] ? 0 : 1);
  ' "$(state_file_for "$home")" "$svc" >/dev/null 2>&1
}

state_keys() {
  local home="$1"

  "$CLI_NODE" -e '
    var fs = require("fs");
    var data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    Object.keys(data.services || {}).forEach(function(key) { console.log(key); });
  ' "$(state_file_for "$home")"
}

state_entry_canonical() {
  local home="$1"
  local svc="$2"

  "$CLI_NODE" -e '
    function sortValue(value) {
      if (Array.isArray(value)) return value.map(sortValue);
      if (value && typeof value === "object") {
        var out = {};
        Object.keys(value).sort().forEach(function(key) {
          out[key] = sortValue(value[key]);
        });
        return out;
      }
      return value;
    }

    var fs = require("fs");
    var data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    var entry = (data.services || {})[process.argv[2]];
    if (!entry) {
      console.error("missing StateStore entry " + process.argv[2]);
      process.exit(2);
    }
    process.stdout.write(JSON.stringify(sortValue(entry)));
  ' "$(state_file_for "$home")" "$svc"
}

state_entry_sha() {
  local home="$1"
  local svc="$2"
  local tmp="$TMP_DIR/state-entry-$svc.json"

  state_entry_canonical "$home" "$svc" > "$tmp" \
    || fail "cannot read StateStore entry $svc"
  sha256_file "$tmp"
}

state_unique_ids() {
  local home="$1"

  "$CLI_NODE" -e '
    var fs = require("fs");
    var data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    var services = data.services || {};
    var keys = Object.keys(services);
    if (keys.length === 0) {
      console.error("StateStore has no services");
      process.exit(2);
    }
    var ids = keys.map(function(key) {
      var id = services[key].pm_id;
      if (!Number.isInteger(id) || id < 0) {
        console.error("invalid pm_id for " + key + ": " + String(id));
        process.exit(3);
      }
      return id;
    });
    var unique = new Set(ids);
    if (unique.size !== ids.length) {
      console.error("duplicate pm_id values: " + ids.join(","));
      process.exit(4);
    }
    var max = Math.max.apply(null, ids);
    if (!Number.isInteger(data.next_id) || data.next_id <= max) {
      console.error("next_id " + String(data.next_id) + " is not above max pm_id " + max);
      process.exit(5);
    }
  ' "$(state_file_for "$home")"
}

assert_state_value() {
  local label="$1"
  local home="$2"
  local svc="$3"
  local key="$4"
  local expected="$5"
  local value

  if ! value="$(state_get "$home" "$svc" "$key")"; then
    fail "$label: StateStore entry $svc has no $key"
  fi
  [[ "$value" == "$expected" ]] \
    || fail "$label: expected StateStore $key=$expected, got $value"
}

assert_state_exec() {
  local label="$1"
  local home="$2"
  local svc="$3"
  local expected="$4"
  local value

  if ! value="$(state_get "$home" "$svc" exec_interpreter)"; then
    fail "$label: StateStore entry $svc has no exec_interpreter"
  fi
  [[ "$(realpath -m -- "$value")" == "$(realpath -m -- "$expected")" ]] \
    || fail "$label: StateStore exec_interpreter is $value, expected $expected"
}

assert_state_metadata() {
  local label="$1"
  local home="$2"
  local app="$3"
  local svc="$4"
  local script="$5"
  local cwd="$6"

  assert_state_value "$label name" "$home" "$svc" name "$app"
  assert_state_value "$label script" "$home" "$svc" script "$script"
  assert_state_value "$label cwd" "$home" "$svc" cwd "$cwd"
  assert_state_value "$label instances" "$home" "$svc" instances 1
}

# ---------------------------------------------------------------------------
# Single-instance and legacy fixture helpers
# ---------------------------------------------------------------------------

assert_only_single_unit() {
  local label="$1"
  local svc="$2"
  local files

  files="$(find "$UNIT_DIR" -maxdepth 1 -name "$svc*.service" -printf '%f\n' 2>/dev/null | sort)"
  [[ "$files" == "$svc.service" ]] \
    || fail "$label: expected only $svc.service, found: ${files:-none}"
  [[ ! -e "$UNIT_DIR/$svc@.service" ]] \
    || fail "$label: template unit unexpectedly exists: $UNIT_DIR/$svc@.service"
  [[ -z "$(systemctl list-units --all --no-legend --no-pager "$svc@*.service" 2>/dev/null || true)" ]] \
    || fail "$label: template instances are loaded"
  [[ -z "$(find "$WANTS_DIR" -maxdepth 1 -name "$svc@*.service" -print -quit 2>/dev/null || true)" ]] \
    || fail "$label: template enablement symlink exists"
}

assert_single_warning() {
  local label="$1"
  local log="$2"

  [[ -s "$log" ]] || fail "$label: command log is empty: $log"
  grep -Eqi 'single[- ]instance|only one instance|instances?[^.]*(ignored|disabled)' "$log" \
    || fail "$label: missing single-instance warning in $log"
}

assert_single_instance_app() {
  local label="$1"
  local home="$2"
  local app="$3"
  local svc="$4"
  local port="$5"
  local health="$6"
  local pid

  assert_express_active "$home" "$app" "$svc" "$port" "$OLD_NODE" "$OLD_VERSION" "$health" "$label"
  assert_state_metadata "$label" "$home" "$app" "$svc" "$FIXTURE" "$FIXTURE_DIR"
  assert_only_single_unit "$label" "$svc"
  assert_env_path_prefixed "$label" "$(env_path_for "$svc")" "$OLD_BIN"
  pid="$(unit_pid "$svc")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || fail "$label: expected a positive MainPID, got '$pid'"
}

delete_scenario_app() {
  local label="$1"
  local app="$2"
  local svc="$3"
  local log="$EVIDENCE_DIR/lifecycle/delete-$svc.log"

  run_zm2 delete "$app" > "$log" 2>&1
  [[ ! -e "$(unit_path_for "$svc")" ]] || fail "$label: unit file still exists after delete"
  [[ ! -e "$UNIT_DIR/$svc@.service" ]] || fail "$label: template unit still exists after delete"
  [[ ! -e "$(env_path_for "$svc")" ]] || fail "$label: environment file still exists after delete"
  [[ ! -L "$WANTS_DIR/$svc.service" ]] || fail "$label: enablement symlink still exists after delete"
  if state_has_service "$ZM2_HOME" "$svc"; then
    fail "$label: StateStore entry still exists after delete"
  fi
  [[ -z "$(systemctl list-units --all --no-legend --no-pager "$svc@*.service" 2>/dev/null || true)" ]] \
    || fail "$label: template instances remain loaded after delete"
}

runtime_signature() {
  local file="$1"

  if [[ -e "$file" ]]; then
    stat -Lc 'present size=%s mtime=%Y inode=%i' -- "$file"
  else
    printf 'absent\n'
  fi
}

write_legacy_state() {
  local home="$1"

  mkdir -p "$home"
  chmod 700 "$home"
  ZM2_REPO="$ZM2_REPO" LEGACY_HOME="$home" LEGACY_APP="$APP_LEGACY" \
    LEGACY_SVC="$SVC_LEGACY" LEGACY_SCRIPT="$STABLE_FIXTURE" \
    LEGACY_CWD="$STABLE_DIR" LEGACY_NODE="$OLD_NODE" "$CLI_NODE" -e '
    var path = require("path");
    var StateStore = require(path.join(process.env.ZM2_REPO, "lib/Systemd/StateStore.js"));
    var store = new StateStore(path.join(process.env.LEGACY_HOME, "state.json"));
    store.register(process.env.LEGACY_SVC, {
      name: process.env.LEGACY_APP,
      script: process.env.LEGACY_SCRIPT,
      cwd: process.env.LEGACY_CWD,
      namespace: "default",
      instances: 2,
      exec_interpreter: process.env.LEGACY_NODE,
      node_args: [],
      args: [],
      version: "N/A"
    });
  '
}

create_legacy_fixture() {
  local home="$1"

  info "Creating legacy template fixture $SVC_LEGACY (instances=2)"
  ZM2_REPO="$ZM2_REPO" LEGACY_APP="$APP_LEGACY" LEGACY_SVC="$SVC_LEGACY" \
    LEGACY_SCRIPT="$STABLE_FIXTURE" LEGACY_CWD="$STABLE_DIR" \
    LEGACY_NODE="$OLD_NODE" LEGACY_RUN_ID="$RUN_ID" "$CLI_NODE" -e '
    var fs = require("fs");
    var path = require("path");
    var UnitGenerator = require(path.join(process.env.ZM2_REPO, "lib/Systemd/UnitGenerator.js"));
    var conf = {
      name: process.env.LEGACY_APP,
      script: process.env.LEGACY_SCRIPT,
      pm_cwd: process.env.LEGACY_CWD,
      cwd: process.env.LEGACY_CWD,
      exec_interpreter: process.env.LEGACY_NODE,
      env: { ZM2_COMPOSE_E2E_RUN_ID: process.env.LEGACY_RUN_ID }
    };
    var svc = process.env.LEGACY_SVC;
    fs.mkdirSync("/etc/zm2/env", { recursive: true, mode: 0o700 });
    fs.writeFileSync("/etc/systemd/system/" + svc + "@.service",
      UnitGenerator.generate(conf, { isTemplate: true }), { mode: 0o644 });
    fs.writeFileSync("/etc/zm2/env/" + svc + ".env",
      UnitGenerator.generateEnvFile(conf), { mode: 0o600 });
  '

  write_legacy_state "$home"
  systemctl daemon-reload
  systemctl enable "$SVC_LEGACY@0.service" "$SVC_LEGACY@1.service" >/dev/null
  systemctl start "$SVC_LEGACY@0.service" "$SVC_LEGACY@1.service"
  wait_active "$SVC_LEGACY@0"
  wait_active "$SVC_LEGACY@1"
  assert_state_value "legacy fixture" "$home" "$SVC_LEGACY" instances 2
}

assert_legacy_snapshot_unchanged() {
  local label="$1"
  local home="$2"
  local unit_sha="$3"
  local env_sha="$4"
  local state_sha="$5"
  local pid0="$6"
  local pid1="$7"
  local enabled1="${8:-1}"

  assert_enabled_state "$label instance 0" "$SVC_LEGACY@0" 1
  assert_enabled_state "$label instance 1" "$SVC_LEGACY@1" "$enabled1"
  [[ "$(sha256_file "$UNIT_DIR/$SVC_LEGACY@.service")" == "$unit_sha" ]] \
    || fail "$label: legacy template unit changed"
  [[ "$(sha256_file "$(env_path_for "$SVC_LEGACY")")" == "$env_sha" ]] \
    || fail "$label: legacy environment file changed"
  [[ "$(state_entry_sha "$home" "$SVC_LEGACY")" == "$state_sha" ]] \
    || fail "$label: legacy StateStore entry changed"
  [[ "$(unit_pid "$SVC_LEGACY@0")" == "$pid0" ]] \
    || fail "$label: legacy instance 0 MainPID changed"
  [[ "$(unit_pid "$SVC_LEGACY@1")" == "$pid1" ]] \
    || fail "$label: legacy instance 1 MainPID changed"
}

run_legacy_rejection() {
  local label="$1"
  local log="$2"
  local rc
  shift 2

  if "$@" > "$log" 2>&1; then rc=0; else rc=$?; fi
  [[ "$rc" -eq 1 ]] || fail "$label: expected exit 1, got $rc"
  grep -Eqi 'multi-instance|single-instance' "$log" \
    || fail "$label: output does not mention disabled multi-instance support"
}

assert_legacy_absent() {
  local label="$1"

  [[ ! -e "$UNIT_DIR/$SVC_LEGACY@.service" ]] \
    || fail "$label: template unit still exists"
  [[ ! -e "$(unit_path_for "$SVC_LEGACY")" ]] \
    || fail "$label: base unit still exists"
  [[ ! -e "$(env_path_for "$SVC_LEGACY")" ]] \
    || fail "$label: environment file still exists"
  [[ -z "$(systemctl list-unit-files --no-legend --no-pager "$SVC_LEGACY@*.service" 2>/dev/null || true)" ]] \
    || fail "$label: systemd still knows template instances"
  [[ -z "$(find "$WANTS_DIR" -maxdepth 1 -name "$SVC_LEGACY@*.service" -print -quit 2>/dev/null || true)" ]] \
    || fail "$label: template enablement symlink still exists"
  if state_has_service "$ZM2_HOME" "$SVC_LEGACY"; then
    fail "$label: StateStore entry still exists"
  fi
}

remove_legacy_update_home() {
  local keys

  [[ -d "$LEGACY_UPDATE_HOME" ]] || return 0
  if [[ -f "$(state_file_for "$LEGACY_UPDATE_HOME")" ]]; then
    ZM2_REPO="$ZM2_REPO" LEGACY_HOME="$LEGACY_UPDATE_HOME" LEGACY_SVC="$SVC_LEGACY" \
      "$CLI_NODE" -e '
      var path = require("path");
      var StateStore = require(path.join(process.env.ZM2_REPO, "lib/Systemd/StateStore.js"));
      new StateStore(path.join(process.env.LEGACY_HOME, "state.json"))
        .unregister(process.env.LEGACY_SVC);
    ' >/dev/null 2>&1 || true
    if ! keys="$(state_keys "$LEGACY_UPDATE_HOME")"; then
      warn "cannot parse legacy update home state; leaving $LEGACY_UPDATE_HOME"
      return 1
    fi
    if [[ -n "$keys" ]]; then
      warn "legacy update home still has services; leaving $LEGACY_UPDATE_HOME"
      return 1
    fi
  fi
  rm -rf -- "$LEGACY_UPDATE_HOME"
}

# ---------------------------------------------------------------------------
# Port / collision / ownership helpers
# ---------------------------------------------------------------------------

assert_port_free() {
  local port="$1"
  local label="$2"

  if ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$port$"; then
    fail "$label: port $port is already in use"
  fi
}

assert_no_owned_collision() {
  local home="$1"
  local app="$2"
  local svc="$3"

  [[ ! -e "$(unit_path_for "$svc")" ]] \
    || fail "refusing to run: unit already exists: $(unit_path_for "$svc")"
  [[ ! -L "$WANTS_DIR/$svc.service" ]] \
    || fail "refusing to run: enablement symlink already exists: $WANTS_DIR/$svc.service"
  [[ ! -e "$(env_path_for "$svc")" ]] \
    || fail "refusing to run: environment file already exists: $(env_path_for "$svc")"
  [[ ! -e "$UNIT_DIR/$svc.service.d" ]] \
    || fail "refusing to run: drop-in directory already exists: $UNIT_DIR/$svc.service.d"
  if state_has_service "$home" "$svc"; then
    fail "refusing to run: StateStore already has $svc in $home"
  fi
}

assert_owned_absent() {
  local svc

  for svc in "$@"; do
    [[ ! -e "$(unit_path_for "$svc")" ]] \
      || fail "cleanup left unit file: $(unit_path_for "$svc")"
    [[ ! -L "$WANTS_DIR/$svc.service" ]] \
      || fail "cleanup left enablement symlink: $WANTS_DIR/$svc.service"
    [[ ! -e "$(env_path_for "$svc")" ]] \
      || fail "cleanup left environment file: $(env_path_for "$svc")"
    [[ ! -e "$UNIT_DIR/$svc@.service" ]] \
      || fail "cleanup left template unit file: $UNIT_DIR/$svc@.service"
    [[ ! -e "$UNIT_DIR/$svc.service.d" ]] \
      || fail "cleanup left drop-in directory: $UNIT_DIR/$svc.service.d"
  done
}

# ---------------------------------------------------------------------------
# App assertions
# ---------------------------------------------------------------------------

assert_express_active() {
  local home="$1"
  local app="$2"
  local svc="$3"
  local port="$4"
  local interpreter="$5"
  local version="$6"
  local health="$7"
  local label="$8"
  local expected_enabled="${9:-1}"
  local pid

  wait_active "$svc"
  wait_http "$port" "$health"
  pid="$(unit_pid "$svc")"

  assert_health "$health" "$pid" "v$version" "$label"
  assert_enabled_state "$label" "$svc" "$expected_enabled"
  assert_proc_exe "$pid" "$interpreter" "$label"
  assert_unit_exec "$label" "$svc" "$interpreter"
  assert_unit_file_exec "$label" "$(unit_path_for "$svc")" "$interpreter"
  assert_state_exec "$label" "$home" "$svc" "$interpreter"
}

assert_express_stopped() {
  local home="$1"
  local app="$2"
  local svc="$3"
  local port="$4"
  local interpreter="$5"
  local label="$6"

  wait_inactive "$svc"
  wait_pid_zero "$svc"

  assert_enabled_state "$label" "$svc" 0
  assert_http_down "$port" "$label"
  assert_unit_exec "$label" "$svc" "$interpreter"
  assert_unit_file_exec "$label" "$(unit_path_for "$svc")" "$interpreter"
  assert_state_exec "$label" "$home" "$svc" "$interpreter"
}

assert_not_active() {
  local svc="$1"
  local label="$2"
  local state
  local pid

  state="$(unit_active_state "$svc")"
  pid="$(unit_pid "$svc")"

  [[ "$state" != "active" ]] \
    || fail "$label: expected a non-active unit, got ActiveState=active"
  [[ "$pid" == "0" ]] \
    || fail "$label: expected MainPID 0, got $pid"
}

journal_contains() {
  local svc="$1"
  local marker="$2"
  local attempts="${3:-50}"
  local i

  for ((i = 0; i < attempts; i++)); do
    if journalctl -u "$svc.service" --no-pager -n 200 -o cat 2>/dev/null | grep -Fq "$marker"; then
      return 0
    fi
    sleep 0.2
  done

  fail "journal for $svc does not contain marker '$marker'"
}

zm2_logs_contains() {
  local app="$1"
  local marker="$2"
  local output="$3"

  run_zm2 logs "$app" --nostream --raw --lines 200 > "$output" 2>&1
  grep -Fq "$marker" "$output" \
    || fail "zm2 logs for $app does not contain marker '$marker'"
}

# ---------------------------------------------------------------------------
# Phase: backend
# ---------------------------------------------------------------------------

phase_backend() {
  local cgroup
  local system_state
  local target_state

  cgroup="$(systemctl show -p ControlGroup --value systemd-journald.service 2>/dev/null || true)"
  system_state="$(systemctl is-system-running 2>/dev/null || true)"
  if [[ -e "$TARGET_NODE" ]]; then
    target_state="present"
  else
    target_state="absent (update-node will install it)"
  fi

  {
    printf 'uname: %s\n' "$(uname -a)"
    printf 'systemctl: %s\n' "$(systemctl --version | head -n 1)"
    printf 'systemd_state: %s\n' "$system_state"
    printf 'pid1_comm: %s\n' "$(tr -d '\n' < /proc/1/comm)"
    printf 'journald_cgroup: %s\n' "$cgroup"
    printf 'cli_node: %s (%s)\n' "$CLI_NODE" "$("$CLI_NODE" --version)"
    printf 'old_node: %s (%s)\n' "$OLD_NODE" "$("$OLD_NODE" --version)"
    printf 'target_node: %s (%s)\n' "$TARGET_NODE" "$target_state"
    printf 'zm2_bin: %s\n' "$ZM2_BIN"
    printf 'zm2_home: %s\n' "$ZM2_HOME"
    printf 'evidence_dir: %s\n' "$EVIDENCE_DIR"
  } > "$EVIDENCE_DIR/backend/versions.txt"

  systemctl --failed --no-legend --no-pager > "$EVIDENCE_DIR/backend/failed-units.txt" 2>&1 || true
  journalctl --no-pager -n 20 -o short-iso > "$EVIDENCE_DIR/backend/journal-head.txt" 2>&1 || true

  if systemctl list-unit-files --no-legend --no-pager 'zm2-compose-e2e-*' 2>/dev/null | grep -q .; then
    warn "existing zm2-compose-e2e-* unit files found; run the cleanup phase before a fresh run"
  fi

  ok "backend: Linux root systemd PID1, responsive systemctl, journald and cgroup namespace verified"
}

# ---------------------------------------------------------------------------
# Phase: lifecycle
# ---------------------------------------------------------------------------

phase_lifecycle() {
  local health="$EVIDENCE_DIR/lifecycle/health-initial.json"
  local pid_before
  local pid_after

  assert_no_owned_collision "$ZM2_HOME" "$APP_LIFECYCLE" "$SVC_LIFECYCLE"
  assert_port_free "$PORT_LIFECYCLE" "lifecycle"

  info "Creating $APP_LIFECYCLE on Node v$OLD_VERSION (port $PORT_LIFECYCLE)"
  HOST=127.0.0.1 PORT="$PORT_LIFECYCLE" \
    run_zm2 start "$FIXTURE" \
      --name "$APP_LIFECYCLE" \
      --interpreter "$OLD_NODE" \
      --cwd "$FIXTURE_DIR" \
      > "$EVIDENCE_DIR/lifecycle/start.log" 2>&1

  assert_express_active "$ZM2_HOME" "$APP_LIFECYCLE" "$SVC_LIFECYCLE" \
    "$PORT_LIFECYCLE" "$OLD_NODE" "$OLD_VERSION" "$health" "lifecycle initial"
  systemd-analyze verify "$(unit_path_for "$SVC_LIFECYCLE")" \
    > "$EVIDENCE_DIR/lifecycle/unit-verify.txt" 2>&1
  assert_state_metadata "lifecycle initial" "$ZM2_HOME" "$APP_LIFECYCLE" \
    "$SVC_LIFECYCLE" "$FIXTURE" "$FIXTURE_DIR"
  assert_env_modes "lifecycle initial" "$SVC_LIFECYCLE"
  assert_env_path_prefixed "lifecycle initial" "$(env_path_for "$SVC_LIFECYCLE")" "$OLD_BIN"
  assert_env_contains "lifecycle initial" "$(env_path_for "$SVC_LIFECYCLE")" "HOST=127.0.0.1"
  assert_env_contains "lifecycle initial" "$(env_path_for "$SVC_LIFECYCLE")" "PORT=$PORT_LIFECYCLE"
  assert_unit_contains "lifecycle initial" "$(unit_path_for "$SVC_LIFECYCLE")" \
    "WorkingDirectory=$FIXTURE_DIR"
  assert_unit_contains "lifecycle initial" "$(unit_path_for "$SVC_LIFECYCLE")" \
    "EnvironmentFile=-/etc/zm2/env/$SVC_LIFECYCLE.env"
  assert_unit_contains "lifecycle initial" "$(unit_path_for "$SVC_LIFECYCLE")" \
    "Restart=on-failure"

  journal_contains "$SVC_LIFECYCLE" "ZM2_EXPRESS_READY"
  journalctl -u "$SVC_LIFECYCLE.service" --no-pager -n 200 -o short-iso \
    > "$EVIDENCE_DIR/lifecycle/journal.log" 2>&1 || true
  zm2_logs_contains "$APP_LIFECYCLE" "ZM2_EXPRESS_READY" \
    "$EVIDENCE_DIR/lifecycle/zm2-logs.txt"

  info "Stopping $APP_LIFECYCLE"
  run_zm2 stop "$APP_LIFECYCLE" > "$EVIDENCE_DIR/lifecycle/stop.log" 2>&1
  assert_express_stopped "$ZM2_HOME" "$APP_LIFECYCLE" "$SVC_LIFECYCLE" \
    "$PORT_LIFECYCLE" "$OLD_NODE" "lifecycle stopped"

  info "Starting the existing stopped app $APP_LIFECYCLE"
  run_zm2 start "$APP_LIFECYCLE" > "$EVIDENCE_DIR/lifecycle/start-existing.log" 2>&1
  assert_express_active "$ZM2_HOME" "$APP_LIFECYCLE" "$SVC_LIFECYCLE" \
    "$PORT_LIFECYCLE" "$OLD_NODE" "$OLD_VERSION" "$health" "lifecycle re-enabled"

  info "Deliberately making env modes permissive, then restarting with --update-env"
  chmod 0755 "$ENV_DIR"
  chmod 0644 "$(env_path_for "$SVC_LIFECYCLE")"

  pid_before="$(unit_pid "$SVC_LIFECYCLE")"
  HOST=127.0.0.1 PORT="$PORT_LIFECYCLE" \
    run_zm2 restart "$APP_LIFECYCLE" --update-env \
      > "$EVIDENCE_DIR/lifecycle/restart-update-env.log" 2>&1

  assert_express_active "$ZM2_HOME" "$APP_LIFECYCLE" "$SVC_LIFECYCLE" \
    "$PORT_LIFECYCLE" "$OLD_NODE" "$OLD_VERSION" "$health" "lifecycle restarted"
  assert_env_modes "lifecycle restarted" "$SVC_LIFECYCLE"
  assert_env_path_prefixed "lifecycle restarted" "$(env_path_for "$SVC_LIFECYCLE")" "$OLD_BIN"
  assert_env_contains "lifecycle restarted" "$(env_path_for "$SVC_LIFECYCLE")" "PORT=$PORT_LIFECYCLE"

  pid_after="$(unit_pid "$SVC_LIFECYCLE")"
  [[ "$pid_after" != "$pid_before" ]] \
    || fail "lifecycle restart: MainPID did not change ($pid_after)"

  info "Externally disabling $SVC_LIFECYCLE, then restarting through the CLI"
  systemctl disable "$SVC_LIFECYCLE.service" >/dev/null 2>&1
  assert_enabled_state "lifecycle externally disabled" "$SVC_LIFECYCLE" 0

  pid_before="$(unit_pid "$SVC_LIFECYCLE")"
  run_zm2 restart "$APP_LIFECYCLE" > "$EVIDENCE_DIR/lifecycle/restart-disabled.log" 2>&1
  assert_express_active "$ZM2_HOME" "$APP_LIFECYCLE" "$SVC_LIFECYCLE" \
    "$PORT_LIFECYCLE" "$OLD_NODE" "$OLD_VERSION" "$health" "lifecycle disabled restart" 0

  pid_after="$(unit_pid "$SVC_LIFECYCLE")"
  [[ "$pid_after" != "$pid_before" ]] \
    || fail "lifecycle disabled restart: MainPID did not change ($pid_after)"

  run_concurrency_scenario
  run_safe_delete_scenario
  run_single_instance_acceptance_scenario
  run_legacy_single_instance_scenario

  ok "lifecycle: start/stop/start, restart, disabled restart, env modes, logs, concurrent registrations, safe-delete, single-instance and legacy rejection verified"
}

# ---------------------------------------------------------------------------
# Lifecycle sub-scenario: concurrent StateStore registrations
# ---------------------------------------------------------------------------

run_concurrency_scenario() {
  local i
  local app
  local svc
  local rc
  local rc_file
  local log_file
  local -a pids=()

  info "Registering $CONCURRENT_COUNT stable fixtures concurrently"

  for ((i = 0; i < CONCURRENT_COUNT; i++)); do
    app="${CONCURRENT_APPS[$i]}"
    svc="${CONCURRENT_SVCS[$i]}"
    assert_no_owned_collision "$ZM2_HOME" "$app" "$svc"

    log_file="$EVIDENCE_DIR/lifecycle/concurrent-$((i + 1)).log"
    rc_file="$TMP_DIR/concurrent-$((i + 1)).rc"

    (
      set +e
      run_zm2 start "$STABLE_FIXTURE" \
          --name "$app" \
          --interpreter "$OLD_NODE" \
          --cwd "$STABLE_DIR" \
          > "$log_file" 2>&1
      rc=$?
      printf '%s\n' "$rc" > "$rc_file"
      exit 0
    ) &
    pids+=("$!")
  done

  for ((i = 0; i < CONCURRENT_COUNT; i++)); do
    wait "${pids[$i]}" || true
  done

  for ((i = 0; i < CONCURRENT_COUNT; i++)); do
    app="${CONCURRENT_APPS[$i]}"
    svc="${CONCURRENT_SVCS[$i]}"
    rc_file="$TMP_DIR/concurrent-$((i + 1)).rc"

    [[ -f "$rc_file" ]] || fail "concurrency: missing exit code for $app"
    rc="$(cat "$rc_file")"
    [[ "$rc" == "0" ]] \
      || fail "concurrency: zm2 start $app exited $rc (see evidence)"

    wait_active "$svc"
    assert_enabled_state "concurrency $app" "$svc" 1
    assert_unit_file_exec "concurrency $app" "$(unit_path_for "$svc")" "$OLD_NODE"
    assert_state_exec "concurrency $app" "$ZM2_HOME" "$svc" "$OLD_NODE"
    assert_state_metadata "concurrency $app" "$ZM2_HOME" "$app" "$svc" \
      "$STABLE_FIXTURE" "$STABLE_DIR"
    assert_env_modes "concurrency $app" "$svc"
    assert_env_path_prefixed "concurrency $app" "$(env_path_for "$svc")" "$OLD_BIN"
  done

  state_unique_ids "$ZM2_HOME"

  # Parse the real state.json and require complete entries for every app.
  "$CLI_NODE" -e '
    var fs = require("fs");
    var data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    var expected = process.argv.slice(2);
    expected.forEach(function(svc) {
      var entry = (data.services || {})[svc];
      if (!entry) {
        console.error("missing StateStore entry " + svc);
        process.exit(2);
      }
      if (!entry.name || !entry.script || !Number.isInteger(entry.pm_id)) {
        console.error("incomplete StateStore entry " + svc);
        process.exit(3);
      }
    });
  ' "$(state_file_for "$ZM2_HOME")" "${CONCURRENT_SVCS[@]}"

  ok "lifecycle/concurrency: $CONCURRENT_COUNT concurrent registrations have complete, unique StateStore IDs"
}

# ---------------------------------------------------------------------------
# Lifecycle sub-scenario: safe delete failure
# ---------------------------------------------------------------------------

run_safe_delete_scenario() {
  local health="$EVIDENCE_DIR/lifecycle/delete-health.json"
  local dropin_dir="$UNIT_DIR/$SVC_DELETE.service.d"
  local dropin_file="$dropin_dir/refuse-manual-stop.conf"
  local log="$EVIDENCE_DIR/lifecycle/delete-refused.log"
  local rc

  assert_no_owned_collision "$ZM2_HOME" "$APP_DELETE" "$SVC_DELETE"
  assert_port_free "$PORT_DELETE" "safe-delete"

  info "Creating $APP_DELETE for the safe-delete failure scenario"
  HOST=127.0.0.1 PORT="$PORT_DELETE" \
    run_zm2 start "$FIXTURE" \
      --name "$APP_DELETE" \
      --interpreter "$OLD_NODE" \
      --cwd "$FIXTURE_DIR" \
      > "$EVIDENCE_DIR/lifecycle/start-delete.log" 2>&1

  assert_express_active "$ZM2_HOME" "$APP_DELETE" "$SVC_DELETE" \
    "$PORT_DELETE" "$OLD_NODE" "$OLD_VERSION" "$health" "safe-delete initial"
  assert_state_metadata "safe-delete initial" "$ZM2_HOME" "$APP_DELETE" \
    "$SVC_DELETE" "$FIXTURE" "$FIXTURE_DIR"

  mkdir -p "$dropin_dir"
  cat > "$dropin_file" <<'EOF'
# ZM2 compose e2e temporary failure injection
[Unit]
RefuseManualStop=yes
EOF
  systemctl daemon-reload
  [[ "$(systemctl show -p RefuseManualStop --value "$SVC_DELETE.service")" == yes ]] \
    || fail "safe-delete: systemd did not accept RefuseManualStop injection"

  info "Deleting $APP_DELETE while systemd refuses manual stop (expected nonzero)"
  if run_zm2 delete "$APP_DELETE" > "$log" 2>&1; then rc=0; else rc=$?; fi

  [[ "$rc" -eq 1 ]] \
    || fail "safe-delete: expected CLI exit 1, got $rc (timeouts do not count as a refusal)"
  grep -Eiq 'refused|RefuseManualStop' "$log" \
    || fail "safe-delete: delete output does not show the injected systemd refusal"
  [[ -e "$(unit_path_for "$SVC_DELETE")" ]] \
    || fail "safe-delete: unit file was removed after a refused stop"
  [[ -e "$(env_path_for "$SVC_DELETE")" ]] \
    || fail "safe-delete: environment file was removed after a refused stop"
  state_has_service "$ZM2_HOME" "$SVC_DELETE" \
    || fail "safe-delete: StateStore entry was removed after a refused stop"
  systemctl is-active --quiet "$SVC_DELETE.service" \
    || fail "safe-delete: unit is no longer active after the refused stop"

  info "Removing the temporary RefuseManualStop drop-in and deleting $APP_DELETE"
  rm -f -- "$dropin_file"
  rmdir -- "$dropin_dir" 2>/dev/null || true
  systemctl daemon-reload

  run_zm2 delete "$APP_DELETE" \
    > "$EVIDENCE_DIR/lifecycle/delete-after-dropin.log" 2>&1

  [[ ! -e "$(unit_path_for "$SVC_DELETE")" ]] \
    || fail "safe-delete: unit file still exists after cleanup"
  [[ ! -e "$(env_path_for "$SVC_DELETE")" ]] \
    || fail "safe-delete: environment file still exists after cleanup"
  if state_has_service "$ZM2_HOME" "$SVC_DELETE"; then
    fail "safe-delete: StateStore entry still exists after cleanup"
  fi
  [[ ! -e "$dropin_dir" ]] \
    || fail "safe-delete: drop-in directory still exists after cleanup"

  ok "lifecycle/safe-delete: refused stop kept unit/env/state, then explicit delete succeeded"
}

# ---------------------------------------------------------------------------
# Lifecycle sub-scenario: accepted instance counts create one service
# ---------------------------------------------------------------------------

run_single_instance_acceptance_scenario() {
  local log
  local health
  local eco

  info "Creating $APP_SINGLE_FLAG with -i 4; one base service is expected"
  assert_no_owned_collision "$ZM2_HOME" "$APP_SINGLE_FLAG" "$SVC_SINGLE_FLAG"
  assert_port_free "$PORT_SINGLE_FLAG" "single -i4"
  log="$EVIDENCE_DIR/lifecycle/single-flag.log"
  health="$EVIDENCE_DIR/lifecycle/single-flag-health.json"
  HOST=127.0.0.1 PORT="$PORT_SINGLE_FLAG" \
    run_zm2 start "$FIXTURE" \
      --name "$APP_SINGLE_FLAG" \
      --interpreter "$OLD_NODE" \
      --cwd "$FIXTURE_DIR" \
      -i 4 > "$log" 2>&1
  assert_single_warning "single -i4" "$log"
  assert_single_instance_app "single -i4" "$ZM2_HOME" "$APP_SINGLE_FLAG" \
    "$SVC_SINGLE_FLAG" "$PORT_SINGLE_FLAG" "$health"
  assert_env_contains "single -i4" "$(env_path_for "$SVC_SINGLE_FLAG")" "PORT=$PORT_SINGLE_FLAG"

  info "Creating $APP_SINGLE_MAX with --instances max; one base service is expected"
  assert_no_owned_collision "$ZM2_HOME" "$APP_SINGLE_MAX" "$SVC_SINGLE_MAX"
  assert_port_free "$PORT_SINGLE_MAX" "single max"
  log="$EVIDENCE_DIR/lifecycle/single-max.log"
  health="$EVIDENCE_DIR/lifecycle/single-max-health.json"
  HOST=127.0.0.1 PORT="$PORT_SINGLE_MAX" \
    run_zm2 start "$FIXTURE" \
      --name "$APP_SINGLE_MAX" \
      --interpreter "$OLD_NODE" \
      --cwd "$FIXTURE_DIR" \
      --instances max > "$log" 2>&1
  assert_single_warning "single max" "$log"
  assert_single_instance_app "single max" "$ZM2_HOME" "$APP_SINGLE_MAX" \
    "$SVC_SINGLE_MAX" "$PORT_SINGLE_MAX" "$health"

  info "Creating $APP_SINGLE_ECO from an ecosystem using process.env.INSTANCES=3"
  assert_no_owned_collision "$ZM2_HOME" "$APP_SINGLE_ECO" "$SVC_SINGLE_ECO"
  assert_port_free "$PORT_SINGLE_ECO" "single ecosystem"
  eco="$TMP_DIR/compose-e2e-single-ecosystem.config.js"
  ECO_FILE="$eco" ECO_APP="$APP_SINGLE_ECO" ECO_SCRIPT="$FIXTURE" \
    ECO_CWD="$FIXTURE_DIR" ECO_NODE="$OLD_NODE" ECO_PORT="$PORT_SINGLE_ECO" \
    "$CLI_NODE" -e '
    var fs = require("fs");
    var e = process.env;
    var source = "module.exports = { apps: [{ name: " + JSON.stringify(e.ECO_APP) +
      ", script: " + JSON.stringify(e.ECO_SCRIPT) +
      ", cwd: " + JSON.stringify(e.ECO_CWD) +
      ", interpreter: " + JSON.stringify(e.ECO_NODE) +
      ", instances: process.env.INSTANCES, env: { HOST: \"127.0.0.1\", PORT: " +
      JSON.stringify(e.ECO_PORT) + ", INSTANCES: process.env.INSTANCES } }] };\n";
    fs.writeFileSync(e.ECO_FILE, source);
  '
  log="$EVIDENCE_DIR/lifecycle/single-ecosystem.log"
  health="$EVIDENCE_DIR/lifecycle/single-ecosystem-health.json"
  ( export INSTANCES=3; run_zm2_home "$ZM2_HOME" 120 start "$eco" > "$log" 2>&1 )
  assert_single_warning "single ecosystem" "$log"
  assert_single_instance_app "single ecosystem" "$ZM2_HOME" "$APP_SINGLE_ECO" \
    "$SVC_SINGLE_ECO" "$PORT_SINGLE_ECO" "$health"
  assert_env_contains "single ecosystem" "$(env_path_for "$SVC_SINGLE_ECO")" "INSTANCES=3"

  delete_scenario_app "single -i4 delete" "$APP_SINGLE_FLAG" "$SVC_SINGLE_FLAG"
  delete_scenario_app "single max delete" "$APP_SINGLE_MAX" "$SVC_SINGLE_MAX"
  delete_scenario_app "single ecosystem delete" "$APP_SINGLE_ECO" "$SVC_SINGLE_ECO"

  ok "lifecycle/single-instance: -i4, --instances max and ecosystem INSTANCES=3 each created one healthy base service"
}

# ---------------------------------------------------------------------------
# Lifecycle sub-scenario: legacy template rejection and continued stop/delete
# ---------------------------------------------------------------------------

run_legacy_single_instance_scenario() {
  local template="$UNIT_DIR/$SVC_LEGACY@.service"
  local env_file
  local log
  local report
  local unit_sha
  local env_sha
  local state_sha
  local iso_state_sha
  local pid0
  local pid1
  local old_sig
  local target_sig
  local rc

  assert_no_owned_collision "$ZM2_HOME" "$APP_LEGACY" "$SVC_LEGACY"
  [[ ! -e "$template" ]] || fail "legacy: template already exists: $template"
  [[ ! -L "$WANTS_DIR/$SVC_LEGACY@.service" ]] \
    || fail "legacy: template enablement symlink already exists"

  create_legacy_fixture "$ZM2_HOME"
  env_file="$(env_path_for "$SVC_LEGACY")"
  unit_sha="$(sha256_file "$template")"
  env_sha="$(sha256_file "$env_file")"
  state_sha="$(state_entry_sha "$ZM2_HOME" "$SVC_LEGACY")"
  pid0="$(unit_pid "$SVC_LEGACY@0")"
  pid1="$(unit_pid "$SVC_LEGACY@1")"

  run_legacy_rejection "legacy start" "$EVIDENCE_DIR/lifecycle/legacy-start.log" \
    run_zm2 start "$APP_LEGACY"
  assert_legacy_snapshot_unchanged "legacy start" "$ZM2_HOME" \
    "$unit_sha" "$env_sha" "$state_sha" "$pid0" "$pid1"

  run_legacy_rejection "legacy restart" "$EVIDENCE_DIR/lifecycle/legacy-restart.log" \
    run_zm2 restart "$APP_LEGACY"
  assert_legacy_snapshot_unchanged "legacy restart" "$ZM2_HOME" \
    "$unit_sha" "$env_sha" "$state_sha" "$pid0" "$pid1"

  run_legacy_rejection "legacy reload" "$EVIDENCE_DIR/lifecycle/legacy-reload.log" \
    run_zm2 reload "$APP_LEGACY"
  assert_legacy_snapshot_unchanged "legacy reload" "$ZM2_HOME" \
    "$unit_sha" "$env_sha" "$state_sha" "$pid0" "$pid1"

  # Discovered aliases must retain their unit identity, never resolve to numeric ID 0.
  local action
  for action in start restart reload; do
    log="$EVIDENCE_DIR/lifecycle/legacy-alias-$action.log"
    run_legacy_rejection "legacy alias $action" "$log" \
      run_zm2 "$action" "$APP_LEGACY@0"
    grep -Fq "$SVC_LEGACY@0" "$log" \
      || fail "legacy alias $action: selected instance identity was lost"
    assert_legacy_snapshot_unchanged "legacy alias $action" "$ZM2_HOME" \
      "$unit_sha" "$env_sha" "$state_sha" "$pid0" "$pid1"
    run_legacy_rejection "legacy canonical ID $action" \
      "$EVIDENCE_DIR/lifecycle/legacy-canonical-$action.log" \
      run_zm2 "$action" "$SVC_LEGACY@0.service"
    assert_legacy_snapshot_unchanged "legacy canonical ID $action" "$ZM2_HOME" \
      "$unit_sha" "$env_sha" "$state_sha" "$pid0" "$pid1"
  done

  info "Disabling and stopping legacy instance 1 before the startup rejection check"
  systemctl disable "$SVC_LEGACY@1.service" >/dev/null
  systemctl stop "$SVC_LEGACY@1.service"
  wait_inactive "$SVC_LEGACY@1"
  wait_pid_zero "$SVC_LEGACY@1"
  assert_enabled_state "legacy startup precondition" "$SVC_LEGACY@1" 0

  run_legacy_rejection "legacy startup" "$EVIDENCE_DIR/lifecycle/legacy-startup.log" \
    run_zm2 startup
  assert_enabled_state "legacy startup" "$SVC_LEGACY@1" 0
  wait_inactive "$SVC_LEGACY@1"
  assert_enabled_state "legacy startup instance 0" "$SVC_LEGACY@0" 1
  assert_legacy_snapshot_unchanged "legacy startup" "$ZM2_HOME" \
    "$unit_sha" "$env_sha" "$state_sha" "$pid0" 0 0

  info "Re-enabling legacy instance 1 for stop/delete coverage"
  systemctl enable "$SVC_LEGACY@1.service" >/dev/null
  systemctl start "$SVC_LEGACY@1.service"
  wait_active "$SVC_LEGACY@1"
  pid1="$(unit_pid "$SVC_LEGACY@1")"

  old_sig="$(runtime_signature "$OLD_NODE")"
  target_sig="$(runtime_signature "$TARGET_NODE")"
  # Fresh private state: never update services from a reused or symlinked home.
  LEGACY_UPDATE_HOME="$(mktemp -d "$TMP_DIR/legacy-update-home.XXXXXX")"
  write_legacy_state "$LEGACY_UPDATE_HOME"
  iso_state_sha="$(state_entry_sha "$LEGACY_UPDATE_HOME" "$SVC_LEGACY")"
  report="$EVIDENCE_DIR/lifecycle/legacy-update-node.log"
  if run_zm2_home "$LEGACY_UPDATE_HOME" 120 update-node "$TARGET_VERSION" > "$report" 2>&1; then
    rc=0
  else
    rc=$?
  fi
  [[ "$rc" -eq 1 ]] || fail "legacy update-node: expected exit 1, got $rc"
  grep -Fq "$SVC_LEGACY" "$report" \
    || fail "legacy update-node: report does not mention $SVC_LEGACY"
  grep -Eqi 'multi-instance|single-instance' "$report" \
    || fail "legacy update-node: report does not mention disabled multi-instance support"
  grep -Eq 'failed, unchanged|failed_unchanged' "$report" \
    || fail "legacy update-node: report does not mark the service failed, unchanged"
  grep -Fq 'Node.js runtime: not prepared' "$report" \
    || fail "legacy update-node: report shows a prepared runtime"
  assert_legacy_snapshot_unchanged "legacy update-node" "$ZM2_HOME" \
    "$unit_sha" "$env_sha" "$state_sha" "$pid0" "$pid1"
  [[ "$(state_entry_sha "$LEGACY_UPDATE_HOME" "$SVC_LEGACY")" == "$iso_state_sha" ]] \
    || fail "legacy update-node: isolated StateStore entry changed"
  [[ "$(runtime_signature "$OLD_NODE")" == "$old_sig" ]] \
    || fail "legacy update-node: old runtime changed"
  [[ "$(runtime_signature "$TARGET_NODE")" == "$target_sig" ]] \
    || fail "legacy update-node: target runtime changed"

  remove_legacy_update_home || fail "legacy update-node: cannot remove isolated home"

  info "Disabling legacy startup entries through the CLI unstartup"
  run_zm2 unstartup > "$EVIDENCE_DIR/lifecycle/legacy-unstartup.log" 2>&1
  assert_enabled_state "legacy unstartup instance 0" "$SVC_LEGACY@0" 0
  assert_enabled_state "legacy unstartup instance 1" "$SVC_LEGACY@1" 0
  [[ -e "$template" ]] || fail "legacy unstartup: template unit was removed"
  state_has_service "$ZM2_HOME" "$SVC_LEGACY" \
    || fail "legacy unstartup: StateStore entry was removed"

  info "Stopping legacy $SVC_LEGACY through the CLI"
  log="$EVIDENCE_DIR/lifecycle/legacy-stop.log"
  run_zm2 stop "$APP_LEGACY" > "$log" 2>&1
  wait_inactive "$SVC_LEGACY@0"
  wait_inactive "$SVC_LEGACY@1"
  wait_pid_zero "$SVC_LEGACY@0"
  wait_pid_zero "$SVC_LEGACY@1"
  [[ -e "$template" ]] || fail "legacy stop: template unit was removed"
  [[ -e "$env_file" ]] || fail "legacy stop: environment file was removed"
  state_has_service "$ZM2_HOME" "$SVC_LEGACY" \
    || fail "legacy stop: StateStore entry was removed"

  info "Deleting legacy $SVC_LEGACY through the CLI"
  run_zm2 delete "$APP_LEGACY" > "$EVIDENCE_DIR/lifecycle/legacy-delete.log" 2>&1
  systemctl reset-failed "$SVC_LEGACY@0.service" "$SVC_LEGACY@1.service" >/dev/null 2>&1 || true
  assert_legacy_absent "legacy delete"

  ok "lifecycle/legacy: start/restart/reload/startup/update-node rejected before mutation; stop/delete handled all instances"
}

# ---------------------------------------------------------------------------
# Phase: prepare-boot
# ---------------------------------------------------------------------------

phase_prepare_boot() {
  local health_enabled="$EVIDENCE_DIR/prepare-boot/health-enabled.json"
  local health_stopped="$EVIDENCE_DIR/prepare-boot/health-stopped.json"
  local init_mono
  local init_wall
  local kernel_boot_id
  local pid1_starttime
  local enabled_unit_sha
  local enabled_env_sha
  local enabled_state_sha
  local stopped_unit_sha
  local stopped_env_sha
  local stopped_state_sha
  local enabled_pid
  local stopped_pid
  local enabled_health_json

  assert_no_owned_collision "$ZM2_HOME" "$APP_BOOT_ENABLED" "$SVC_BOOT_ENABLED"
  assert_no_owned_collision "$ZM2_HOME" "$APP_BOOT_STOPPED" "$SVC_BOOT_STOPPED"
  assert_port_free "$PORT_BOOT_ENABLED" "prepare-boot enabled"
  assert_port_free "$PORT_BOOT_STOPPED" "prepare-boot stopped"

  info "Creating enabled app $APP_BOOT_ENABLED on port $PORT_BOOT_ENABLED"
  HOST=127.0.0.1 PORT="$PORT_BOOT_ENABLED" \
    run_zm2 start "$FIXTURE" \
      --name "$APP_BOOT_ENABLED" \
      --interpreter "$OLD_NODE" \
      --cwd "$FIXTURE_DIR" \
      > "$EVIDENCE_DIR/prepare-boot/start-enabled.log" 2>&1

  assert_express_active "$ZM2_HOME" "$APP_BOOT_ENABLED" "$SVC_BOOT_ENABLED" \
    "$PORT_BOOT_ENABLED" "$OLD_NODE" "$OLD_VERSION" "$health_enabled" "prepare-boot enabled"
  assert_state_metadata "prepare-boot enabled" "$ZM2_HOME" "$APP_BOOT_ENABLED" \
    "$SVC_BOOT_ENABLED" "$FIXTURE" "$FIXTURE_DIR"
  assert_env_modes "prepare-boot enabled" "$SVC_BOOT_ENABLED"
  assert_env_path_prefixed "prepare-boot enabled" "$(env_path_for "$SVC_BOOT_ENABLED")" "$OLD_BIN"

  info "Creating app $APP_BOOT_STOPPED on port $PORT_BOOT_STOPPED, then stopping it"
  HOST=127.0.0.1 PORT="$PORT_BOOT_STOPPED" \
    run_zm2 start "$FIXTURE" \
      --name "$APP_BOOT_STOPPED" \
      --interpreter "$OLD_NODE" \
      --cwd "$FIXTURE_DIR" \
      > "$EVIDENCE_DIR/prepare-boot/start-stopped.log" 2>&1

  assert_express_active "$ZM2_HOME" "$APP_BOOT_STOPPED" "$SVC_BOOT_STOPPED" \
    "$PORT_BOOT_STOPPED" "$OLD_NODE" "$OLD_VERSION" "$health_stopped" "prepare-boot stopped initial"
  assert_state_metadata "prepare-boot stopped" "$ZM2_HOME" "$APP_BOOT_STOPPED" \
    "$SVC_BOOT_STOPPED" "$FIXTURE" "$FIXTURE_DIR"
  assert_env_modes "prepare-boot stopped" "$SVC_BOOT_STOPPED"
  assert_env_path_prefixed "prepare-boot stopped" "$(env_path_for "$SVC_BOOT_STOPPED")" "$OLD_BIN"

  run_zm2 stop "$APP_BOOT_STOPPED" > "$EVIDENCE_DIR/prepare-boot/stop-stopped.log" 2>&1
  assert_express_stopped "$ZM2_HOME" "$APP_BOOT_STOPPED" "$SVC_BOOT_STOPPED" \
    "$PORT_BOOT_STOPPED" "$OLD_NODE" "prepare-boot stopped"

  init_mono="$(systemctl show -p UserspaceTimestampMonotonic --value 2>/dev/null | tr -d '[:space:]')"
  init_wall="$(systemctl show -p UserspaceTimestamp --value 2>/dev/null | tr -d '\n')"
  kernel_boot_id="$(tr -d '\n' < /proc/sys/kernel/random/boot_id)"
  pid1_starttime="$(awk '{print $22}' /proc/1/stat)"

  [[ -n "$init_mono" ]] || fail "prepare-boot: UserspaceTimestampMonotonic is empty"
  [[ -n "$init_wall" ]] || fail "prepare-boot: UserspaceTimestamp is empty"

  enabled_unit_sha="$(sha256_file "$(unit_path_for "$SVC_BOOT_ENABLED")")"
  enabled_env_sha="$(sha256_file "$(env_path_for "$SVC_BOOT_ENABLED")")"
  enabled_state_sha="$(state_entry_sha "$ZM2_HOME" "$SVC_BOOT_ENABLED")"
  stopped_unit_sha="$(sha256_file "$(unit_path_for "$SVC_BOOT_STOPPED")")"
  stopped_env_sha="$(sha256_file "$(env_path_for "$SVC_BOOT_STOPPED")")"
  stopped_state_sha="$(state_entry_sha "$ZM2_HOME" "$SVC_BOOT_STOPPED")"

  enabled_pid="$(unit_pid "$SVC_BOOT_ENABLED")"
  stopped_pid="$(unit_pid "$SVC_BOOT_STOPPED")"
  enabled_health_json="$(cat "$health_enabled")"

  BOOT_RUN_ID="$RUN_ID" \
  BOOT_INIT_MONOTONIC="$init_mono" \
  BOOT_INIT_WALL="$init_wall" \
  BOOT_KERNEL_BOOT_ID="$kernel_boot_id" \
  BOOT_PID1_STARTTIME="$pid1_starttime" \
  BOOT_ENABLED_SVC="$SVC_BOOT_ENABLED" \
  BOOT_ENABLED_APP="$APP_BOOT_ENABLED" \
  BOOT_ENABLED_ENABLED=1 \
  BOOT_ENABLED_PORT="$PORT_BOOT_ENABLED" \
  BOOT_ENABLED_UNIT_SHA="$enabled_unit_sha" \
  BOOT_ENABLED_ENV_SHA="$enabled_env_sha" \
  BOOT_ENABLED_STATE_SHA="$enabled_state_sha" \
  BOOT_ENABLED_PID="$enabled_pid" \
  BOOT_ENABLED_HEALTH_JSON="$enabled_health_json" \
  BOOT_STOPPED_SVC="$SVC_BOOT_STOPPED" \
  BOOT_STOPPED_APP="$APP_BOOT_STOPPED" \
  BOOT_STOPPED_PORT="$PORT_BOOT_STOPPED" \
  BOOT_STOPPED_UNIT_SHA="$stopped_unit_sha" \
  BOOT_STOPPED_ENV_SHA="$stopped_env_sha" \
  BOOT_STOPPED_STATE_SHA="$stopped_state_sha" \
  BOOT_STOPPED_PID="$stopped_pid" \
  "$CLI_NODE" -e '
    var e = process.env;
    var apps = {};
    apps[e.BOOT_ENABLED_SVC] = {
      app: e.BOOT_ENABLED_APP,
      port: Number(e.BOOT_ENABLED_PORT),
      unit_sha256: e.BOOT_ENABLED_UNIT_SHA,
      env_sha256: e.BOOT_ENABLED_ENV_SHA,
      state_entry_sha256: e.BOOT_ENABLED_STATE_SHA,
      enabled: e.BOOT_ENABLED_ENABLED !== "0",
      active: true,
      main_pid: Number(e.BOOT_ENABLED_PID),
      health: JSON.parse(e.BOOT_ENABLED_HEALTH_JSON)
    };
    apps[e.BOOT_STOPPED_SVC] = {
      app: e.BOOT_STOPPED_APP,
      port: Number(e.BOOT_STOPPED_PORT),
      unit_sha256: e.BOOT_STOPPED_UNIT_SHA,
      env_sha256: e.BOOT_STOPPED_ENV_SHA,
      state_entry_sha256: e.BOOT_STOPPED_STATE_SHA,
      enabled: false,
      active: false,
      main_pid: Number(e.BOOT_STOPPED_PID),
      health: null
    };
    var snapshot = {
      run_id: e.BOOT_RUN_ID,
      created_at: new Date().toISOString(),
      init: {
        pid1_comm: "systemd",
        userspace_timestamp_monotonic: e.BOOT_INIT_MONOTONIC,
        userspace_timestamp: e.BOOT_INIT_WALL,
        kernel_boot_id: e.BOOT_KERNEL_BOOT_ID,
        pid1_starttime: e.BOOT_PID1_STARTTIME
      },
      apps: apps
    };
    process.stdout.write(JSON.stringify(snapshot, null, 2));
  ' > "$BOOT_SNAPSHOT"

  {
    printf 'run_id=%s\n' "$RUN_ID"
    printf 'userspace_timestamp_monotonic=%s\n' "$init_mono"
    printf 'userspace_timestamp=%s\n' "$init_wall"
    printf 'kernel_boot_id=%s\n' "$kernel_boot_id"
    printf 'pid1_starttime=%s\n' "$pid1_starttime"
    printf '%s unit_sha256=%s\n' "$SVC_BOOT_ENABLED" "$enabled_unit_sha"
    printf '%s env_sha256=%s\n' "$SVC_BOOT_ENABLED" "$enabled_env_sha"
    printf '%s state_entry_sha256=%s\n' "$SVC_BOOT_ENABLED" "$enabled_state_sha"
    printf '%s unit_sha256=%s\n' "$SVC_BOOT_STOPPED" "$stopped_unit_sha"
    printf '%s env_sha256=%s\n' "$SVC_BOOT_STOPPED" "$stopped_env_sha"
    printf '%s state_entry_sha256=%s\n' "$SVC_BOOT_STOPPED" "$stopped_state_sha"
  } > "$EVIDENCE_DIR/prepare-boot/summary.txt"

  ok "prepare-boot: enabled Express on $PORT_BOOT_ENABLED active, stopped app on $PORT_BOOT_STOPPED down, snapshot captured"
}

# ---------------------------------------------------------------------------
# Phase: verify-boot
# ---------------------------------------------------------------------------

phase_verify_boot() {
  local before_mono
  local before_wall
  local before_boot_id
  local before_pid1_start
  local current_mono
  local current_wall
  local current_boot_id
  local current_pid1_start
  local health_enabled="$EVIDENCE_DIR/verify-boot/health-enabled.json"
  local health_stopped="$EVIDENCE_DIR/verify-boot/health-stopped.json"
  local unit_sha
  local env_sha
  local state_sha

  [[ -f "$BOOT_SNAPSHOT" ]] \
    || fail "verify-boot: snapshot is missing: $BOOT_SNAPSHOT (run prepare-boot first)"

  before_mono="$(json_get "$BOOT_SNAPSHOT" init.userspace_timestamp_monotonic)"
  before_wall="$(json_get "$BOOT_SNAPSHOT" init.userspace_timestamp)"
  before_boot_id="$(json_get "$BOOT_SNAPSHOT" init.kernel_boot_id)"
  before_pid1_start="$(json_get "$BOOT_SNAPSHOT" init.pid1_starttime)"

  [[ "$(tr -d '\n' < /proc/1/comm)" == "systemd" ]] \
    || fail "verify-boot: PID 1 is not systemd after restart"

  current_mono="$(systemctl show -p UserspaceTimestampMonotonic --value 2>/dev/null | tr -d '[:space:]')"
  current_wall="$(systemctl show -p UserspaceTimestamp --value 2>/dev/null | tr -d '\n')"
  current_boot_id="$(tr -d '\n' < /proc/sys/kernel/random/boot_id)"
  current_pid1_start="$(awk '{print $22}' /proc/1/stat)"

  [[ -n "$current_mono" ]] || fail "verify-boot: UserspaceTimestampMonotonic is empty"
  [[ "$current_mono" != "$before_mono" ]] \
    || fail "verify-boot: systemd UserspaceTimestampMonotonic did not change ($current_mono)"
  if [[ "$current_mono" =~ ^[0-9]+$ && "$before_mono" =~ ^[0-9]+$ ]]; then
    (( current_mono > before_mono )) \
      || fail "verify-boot: UserspaceTimestampMonotonic did not advance ($before_mono -> $current_mono)"
  fi
  if [[ "$current_wall" == "$before_wall" ]]; then
    warn "verify-boot: UserspaceTimestamp did not change; the monotonic userspace timestamp proves a new invocation"
  fi
  [[ "$current_boot_id" == "$before_boot_id" ]] \
    || fail "verify-boot: kernel boot id changed; this phase expects the same container/kernel"
  [[ "$current_pid1_start" != "$before_pid1_start" ]] \
    || warn "verify-boot: PID 1 starttime is unchanged; relying on the systemd userspace timestamp"

  info "Enabled app must be active automatically, without any zm2 start call"
  assert_express_active "$ZM2_HOME" "$APP_BOOT_ENABLED" "$SVC_BOOT_ENABLED" \
    "$PORT_BOOT_ENABLED" "$OLD_NODE" "$OLD_VERSION" "$health_enabled" "verify-boot enabled"

  unit_sha="$(sha256_file "$(unit_path_for "$SVC_BOOT_ENABLED")")"
  env_sha="$(sha256_file "$(env_path_for "$SVC_BOOT_ENABLED")")"
  state_sha="$(state_entry_sha "$ZM2_HOME" "$SVC_BOOT_ENABLED")"
  [[ "$unit_sha" == "$(json_get "$BOOT_SNAPSHOT" "apps.$SVC_BOOT_ENABLED.unit_sha256")" ]] \
    || fail "verify-boot: enabled unit file changed across restart"
  [[ "$env_sha" == "$(json_get "$BOOT_SNAPSHOT" "apps.$SVC_BOOT_ENABLED.env_sha256")" ]] \
    || fail "verify-boot: enabled environment file changed across restart"
  [[ "$state_sha" == "$(json_get "$BOOT_SNAPSHOT" "apps.$SVC_BOOT_ENABLED.state_entry_sha256")" ]] \
    || fail "verify-boot: enabled StateStore entry changed across restart"

  assert_state_metadata "verify-boot enabled" "$ZM2_HOME" "$APP_BOOT_ENABLED" \
    "$SVC_BOOT_ENABLED" "$FIXTURE" "$FIXTURE_DIR"
  assert_env_modes "verify-boot enabled" "$SVC_BOOT_ENABLED"
  assert_env_path_prefixed "verify-boot enabled" "$(env_path_for "$SVC_BOOT_ENABLED")" "$OLD_BIN"

  info "Stopped app must remain stopped and disabled"
  assert_express_stopped "$ZM2_HOME" "$APP_BOOT_STOPPED" "$SVC_BOOT_STOPPED" \
    "$PORT_BOOT_STOPPED" "$OLD_NODE" "verify-boot stopped"
  assert_env_modes "verify-boot stopped" "$SVC_BOOT_STOPPED"

  unit_sha="$(sha256_file "$(unit_path_for "$SVC_BOOT_STOPPED")")"
  env_sha="$(sha256_file "$(env_path_for "$SVC_BOOT_STOPPED")")"
  state_sha="$(state_entry_sha "$ZM2_HOME" "$SVC_BOOT_STOPPED")"
  [[ "$unit_sha" == "$(json_get "$BOOT_SNAPSHOT" "apps.$SVC_BOOT_STOPPED.unit_sha256")" ]] \
    || fail "verify-boot: stopped unit file changed across restart"
  [[ "$env_sha" == "$(json_get "$BOOT_SNAPSHOT" "apps.$SVC_BOOT_STOPPED.env_sha256")" ]] \
    || fail "verify-boot: stopped environment file changed across restart"
  [[ "$state_sha" == "$(json_get "$BOOT_SNAPSHOT" "apps.$SVC_BOOT_STOPPED.state_entry_sha256")" ]] \
    || fail "verify-boot: stopped StateStore entry changed across restart"

  {
    printf 'before_userspace_timestamp_monotonic=%s\n' "$before_mono"
    printf 'after_userspace_timestamp_monotonic=%s\n' "$current_mono"
    printf 'before_userspace_timestamp=%s\n' "$before_wall"
    printf 'after_userspace_timestamp=%s\n' "$current_wall"
    printf 'kernel_boot_id=%s\n' "$current_boot_id"
    printf 'pid1_starttime_before=%s\n' "$before_pid1_start"
    printf 'pid1_starttime_after=%s\n' "$current_pid1_start"
  } > "$EVIDENCE_DIR/verify-boot/init-identity.txt"

  ok "verify-boot: new systemd userspace invocation, auto-start without zm2 start, hashes preserved"
}

# ---------------------------------------------------------------------------
# Phase: no-rollback
# ---------------------------------------------------------------------------

phase_no_rollback() {
  local home="$NOROLLBACK_HOME"
  local report="$EVIDENCE_DIR/no-rollback/update-node-report.txt"
  local rc
  local existing_keys
  local health_fail="$EVIDENCE_DIR/no-rollback/health-fail-before.json"
  local health_ok="$EVIDENCE_DIR/no-rollback/health-ok-before.json"
  local health_stopped="$EVIDENCE_DIR/no-rollback/health-stopped-before.json"
  local health_ok_after="$EVIDENCE_DIR/no-rollback/health-ok-after.json"

  if [[ -e "$home" ]]; then
    if [[ -f "$(state_file_for "$home")" ]]; then
      if ! existing_keys="$(state_keys "$home")"; then
        fail "no-rollback: cannot parse nested StateStore: $(state_file_for "$home")"
      fi
      [[ -z "$existing_keys" ]] \
        || fail "no-rollback: nested home is not empty: $home (run cleanup first)"
    fi
  else
    mkdir -p "$home"
    chmod 700 "$home"
  fi

  assert_no_owned_collision "$home" "$APP_NR_FAIL" "$SVC_NR_FAIL"
  assert_no_owned_collision "$home" "$APP_NR_OK" "$SVC_NR_OK"
  assert_no_owned_collision "$home" "$APP_NR_STOPPED" "$SVC_NR_STOPPED"
  assert_port_free "$PORT_NR_FAIL" "no-rollback fail"
  assert_port_free "$PORT_NR_OK" "no-rollback ok"
  assert_port_free "$PORT_NR_STOPPED" "no-rollback stopped"

  info "Creating incompatible app $APP_NR_FAIL on old Node v$OLD_VERSION (fails only on v$TARGET_VERSION)"
  HOST=127.0.0.1 PORT="$PORT_NR_FAIL" FAIL_ON_NODE_VERSION="$TARGET_VERSION" \
    run_zm2_norollback start "$FIXTURE" \
      --name "$APP_NR_FAIL" \
      --interpreter "$OLD_NODE" \
      --cwd "$FIXTURE_DIR" \
      --no-autorestart \
      > "$EVIDENCE_DIR/no-rollback/start-fail.log" 2>&1

  assert_express_active "$home" "$APP_NR_FAIL" "$SVC_NR_FAIL" \
    "$PORT_NR_FAIL" "$OLD_NODE" "$OLD_VERSION" "$health_fail" "no-rollback fail initial"
  assert_state_metadata "no-rollback fail initial" "$home" "$APP_NR_FAIL" \
    "$SVC_NR_FAIL" "$FIXTURE" "$FIXTURE_DIR"
  assert_unit_contains "no-rollback fail initial" "$(unit_path_for "$SVC_NR_FAIL")" "Restart=no"
  assert_env_contains "no-rollback fail initial" "$(env_path_for "$SVC_NR_FAIL")" \
    "FAIL_ON_NODE_VERSION=$TARGET_VERSION"

  info "Creating compatible app $APP_NR_OK on old Node v$OLD_VERSION"
  HOST=127.0.0.1 PORT="$PORT_NR_OK" \
    run_zm2_norollback start "$FIXTURE" \
      --name "$APP_NR_OK" \
      --interpreter "$OLD_NODE" \
      --cwd "$FIXTURE_DIR" \
      > "$EVIDENCE_DIR/no-rollback/start-ok.log" 2>&1

  assert_express_active "$home" "$APP_NR_OK" "$SVC_NR_OK" \
    "$PORT_NR_OK" "$OLD_NODE" "$OLD_VERSION" "$health_ok" "no-rollback ok initial"
  assert_state_metadata "no-rollback ok initial" "$home" "$APP_NR_OK" \
    "$SVC_NR_OK" "$FIXTURE" "$FIXTURE_DIR"

  info "Creating stopped app $APP_NR_STOPPED on old Node v$OLD_VERSION"
  HOST=127.0.0.1 PORT="$PORT_NR_STOPPED" \
    run_zm2_norollback start "$FIXTURE" \
      --name "$APP_NR_STOPPED" \
      --interpreter "$OLD_NODE" \
      --cwd "$FIXTURE_DIR" \
      > "$EVIDENCE_DIR/no-rollback/start-stopped.log" 2>&1

  assert_express_active "$home" "$APP_NR_STOPPED" "$SVC_NR_STOPPED" \
    "$PORT_NR_STOPPED" "$OLD_NODE" "$OLD_VERSION" "$health_stopped" "no-rollback stopped initial"
  run_zm2_norollback stop "$APP_NR_STOPPED" \
    > "$EVIDENCE_DIR/no-rollback/stop-stopped.log" 2>&1
  assert_express_stopped "$home" "$APP_NR_STOPPED" "$SVC_NR_STOPPED" \
    "$PORT_NR_STOPPED" "$OLD_NODE" "no-rollback stopped"

  assert_enabled_state "no-rollback fail initial" "$SVC_NR_FAIL" 1
  assert_enabled_state "no-rollback ok initial" "$SVC_NR_OK" 1
  assert_enabled_state "no-rollback stopped initial" "$SVC_NR_STOPPED" 0

  info "Running: zm2 update-node $TARGET_VERSION --no-rollback (expected exit 1)"
  if run_zm2_home "$home" 120 update-node "$TARGET_VERSION" --no-rollback > "$report" 2>&1; then
    rc=0
  else
    rc=$?
  fi

  info "update-node --no-rollback exit code: $rc"
  printf '%s\n' '--- update-node --no-rollback report ---'
  cat "$report"
  printf '%s\n' '--- end report ---'

  [[ "$rc" -eq 1 ]] \
    || fail "no-rollback: expected update-node to exit 1, got $rc"
  [[ -s "$report" ]] || fail "no-rollback: update-node report is empty"
  grep -Fq "$TARGET_VERSION" "$report" \
    || fail "no-rollback: report does not mention requested version $TARGET_VERSION"
  for svc in "$SVC_NR_FAIL" "$SVC_NR_OK" "$SVC_NR_STOPPED"; do
    grep -Fq "$svc" "$report" || fail "no-rollback: report does not mention $svc"
  done
  if ! grep -Eqi 'no[ -]rollback|configuration updated' "$report"; then
    fail "no-rollback: report does not identify retained configuration / disabled rollback"
  fi
  if grep -Fq 'failed, restored' "$report"; then
    fail "no-rollback: report falsely claims a rollback/restore"
  fi

  assert_runtime "$TARGET_NODE" "$TARGET_VERSION" "no-rollback target runtime"

  info "Incompatible app must keep target configuration but must not be healthy"
  assert_unit_exec "no-rollback fail target" "$SVC_NR_FAIL" "$TARGET_NODE"
  assert_unit_file_exec "no-rollback fail target" "$(unit_path_for "$SVC_NR_FAIL")" "$TARGET_NODE"
  assert_env_path_prefixed "no-rollback fail target" "$(env_path_for "$SVC_NR_FAIL")" "$TARGET_BIN"
  assert_env_contains "no-rollback fail target" "$(env_path_for "$SVC_NR_FAIL")" \
    "FAIL_ON_NODE_VERSION=$TARGET_VERSION"
  assert_state_exec "no-rollback fail target" "$home" "$SVC_NR_FAIL" "$TARGET_NODE"
  assert_env_modes "no-rollback fail target" "$SVC_NR_FAIL"
  assert_not_active "$SVC_NR_FAIL" "no-rollback fail target"
  assert_http_down "$PORT_NR_FAIL" "no-rollback fail target"

  info "Compatible app must be active on the target runtime and healthy over HTTP"
  assert_express_active "$home" "$APP_NR_OK" "$SVC_NR_OK" \
    "$PORT_NR_OK" "$TARGET_NODE" "$TARGET_VERSION" "$health_ok_after" "no-rollback ok target"
  assert_unit_file_exec "no-rollback ok target" "$(unit_path_for "$SVC_NR_OK")" "$TARGET_NODE"
  assert_env_path_prefixed "no-rollback ok target" "$(env_path_for "$SVC_NR_OK")" "$TARGET_BIN"
  assert_state_exec "no-rollback ok target" "$home" "$SVC_NR_OK" "$TARGET_NODE"
  assert_env_modes "no-rollback ok target" "$SVC_NR_OK"

  info "Stopped app must keep target configuration and remain stopped/disabled"
  assert_express_stopped "$home" "$APP_NR_STOPPED" "$SVC_NR_STOPPED" \
    "$PORT_NR_STOPPED" "$TARGET_NODE" "no-rollback stopped target"
  assert_unit_file_exec "no-rollback stopped target" "$(unit_path_for "$SVC_NR_STOPPED")" "$TARGET_NODE"
  assert_env_path_prefixed "no-rollback stopped target" "$(env_path_for "$SVC_NR_STOPPED")" "$TARGET_BIN"
  assert_state_exec "no-rollback stopped target" "$home" "$SVC_NR_STOPPED" "$TARGET_NODE"
  assert_env_modes "no-rollback stopped target" "$SVC_NR_STOPPED"

  ok "no-rollback: target retained on failure, compatible app healthy on target, stopped app stayed stopped"
}

# ---------------------------------------------------------------------------
# Phase: cleanup
# ---------------------------------------------------------------------------

remove_delete_dropin() {
  local dir="$UNIT_DIR/$SVC_DELETE.service.d"
  local file="$dir/refuse-manual-stop.conf"

  if [[ -f "$file" ]] && grep -Fq "ZM2 compose e2e" "$file"; then
    rm -f -- "$file"
  fi
  if [[ -d "$dir" ]]; then
    rmdir -- "$dir" 2>/dev/null || true
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
}

delete_owned_app() {
  local home="$1"
  local app="$2"
  local svc="$3"
  local log="$EVIDENCE_DIR/cleanup/delete-$svc.log"
  local template="$UNIT_DIR/$svc@.service"
  local had_template=0
  local rc

  if [[ -e "$template" ]]; then
    had_template=1
  fi
  if [[ -e "$(unit_path_for "$svc")" ]] \
    && ! grep -Fq "Description=ZM2: $app" "$(unit_path_for "$svc")"; then
    warn "not deleting unexpected unit $(unit_path_for "$svc")"
    return 1
  fi
  if [[ -e "$template" ]] && ! grep -Fq "Description=ZM2: $app" "$template"; then
    warn "not deleting unexpected template unit $template"
    return 1
  fi

  if state_has_service "$home" "$svc" \
    || [[ -e "$(unit_path_for "$svc")" ]] \
    || [[ -e "$template" ]] \
    || [[ -e "$(env_path_for "$svc")" ]] \
    || [[ -L "$WANTS_DIR/$svc.service" ]]; then
    info "Deleting $svc through the ZM2 CLI"
    set +e
    run_zm2_home "$home" 120 delete "$app" > "$log" 2>&1
    rc=$?
    set -e

    if [[ "$rc" -ne 0 ]]; then
      warn "delete failed for $svc (exit $rc); resetting failed state and retrying once"
      systemctl reset-failed "$svc.service" "$svc@0.service" "$svc@1.service" >/dev/null 2>&1 || true
      set +e
      run_zm2_home "$home" 120 delete "$app" >> "$log" 2>&1
      rc=$?
      set -e
    fi

    if [[ "$rc" -ne 0 ]]; then
      warn "could not delete $svc; resources retained for diagnosis (see $log)"
      return 1
    fi
  fi

  # Removed failed services can remain as not-found/failed tombstones in PID 1.
  # Clear only the owned unit, after its CLI deletion has succeeded.
  if [[ "$had_template" -eq 1 ]]; then
    systemctl reset-failed "$svc@0.service" "$svc@1.service" >/dev/null 2>&1 || true
  fi
  if [[ "$(unit_active_state "$svc")" == failed ]]; then
    systemctl reset-failed "$svc.service" || return 1
  fi
  return 0
}

remove_nested_home() {
  local keys

  [[ -d "$NOROLLBACK_HOME" ]] || return 0

  if [[ -f "$(state_file_for "$NOROLLBACK_HOME")" ]]; then
    if ! keys="$(state_keys "$NOROLLBACK_HOME")"; then
      warn "cannot parse nested StateStore; leaving $NOROLLBACK_HOME"
      return 1
    fi
    if [[ -n "$keys" ]]; then
      warn "nested StateStore still has services; leaving $NOROLLBACK_HOME"
      return 1
    fi
  fi

  rm -rf -- "$NOROLLBACK_HOME"
  return 0
}

phase_cleanup() {
  local failures=0
  local owned
  local leftovers
  local i

  remove_delete_dropin

  delete_owned_app "$ZM2_HOME" "$APP_LIFECYCLE" "$SVC_LIFECYCLE" \
    || failures=$((failures + 1))
  delete_owned_app "$ZM2_HOME" "$APP_BOOT_ENABLED" "$SVC_BOOT_ENABLED" \
    || failures=$((failures + 1))
  delete_owned_app "$ZM2_HOME" "$APP_BOOT_STOPPED" "$SVC_BOOT_STOPPED" \
    || failures=$((failures + 1))
  delete_owned_app "$ZM2_HOME" "$APP_DELETE" "$SVC_DELETE" \
    || failures=$((failures + 1))
  delete_owned_app "$ZM2_HOME" "$APP_SINGLE_FLAG" "$SVC_SINGLE_FLAG" \
    || failures=$((failures + 1))
  delete_owned_app "$ZM2_HOME" "$APP_SINGLE_MAX" "$SVC_SINGLE_MAX" \
    || failures=$((failures + 1))
  delete_owned_app "$ZM2_HOME" "$APP_SINGLE_ECO" "$SVC_SINGLE_ECO" \
    || failures=$((failures + 1))
  delete_owned_app "$ZM2_HOME" "$APP_LEGACY" "$SVC_LEGACY" \
    || failures=$((failures + 1))

  for ((i = 0; i < CONCURRENT_COUNT; i++)); do
    delete_owned_app "$ZM2_HOME" "${CONCURRENT_APPS[$i]}" "${CONCURRENT_SVCS[$i]}" \
      || failures=$((failures + 1))
  done

  delete_owned_app "$NOROLLBACK_HOME" "$APP_NR_FAIL" "$SVC_NR_FAIL" \
    || failures=$((failures + 1))
  delete_owned_app "$NOROLLBACK_HOME" "$APP_NR_OK" "$SVC_NR_OK" \
    || failures=$((failures + 1))
  delete_owned_app "$NOROLLBACK_HOME" "$APP_NR_STOPPED" "$SVC_NR_STOPPED" \
    || failures=$((failures + 1))

  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl reset-failed "$SVC_LEGACY@0.service" "$SVC_LEGACY@1.service" >/dev/null 2>&1 || true

  if ! remove_nested_home; then
    failures=$((failures + 1))
  fi
  if ! remove_legacy_update_home; then
    failures=$((failures + 1))
  fi

  assert_owned_absent \
    "$SVC_LIFECYCLE" \
    "$SVC_BOOT_ENABLED" \
    "$SVC_BOOT_STOPPED" \
    "$SVC_DELETE" \
    "$SVC_SINGLE_FLAG" \
    "$SVC_SINGLE_MAX" \
    "$SVC_SINGLE_ECO" \
    "$SVC_LEGACY" \
    "${CONCURRENT_SVCS[@]}" \
    "$SVC_NR_FAIL" \
    "$SVC_NR_OK" \
    "$SVC_NR_STOPPED"

  [[ ! -e "$UNIT_DIR/$SVC_LEGACY@.service" ]] \
    || fail "cleanup left the legacy template unit"
  [[ -z "$(find "$WANTS_DIR" -maxdepth 1 -name "$SVC_LEGACY@*.service" -print -quit 2>/dev/null || true)" ]] \
    || fail "cleanup left legacy template enablement symlinks"

  if [[ -f "$(state_file_for "$ZM2_HOME")" ]]; then
    if ! owned="$(state_keys "$ZM2_HOME")"; then
      fail "cleanup: cannot parse the main StateStore: $(state_file_for "$ZM2_HOME")"
    fi
    owned="$(printf '%s\n' "$owned" | grep '^zm2-compose-e2e-' || true)"
    [[ -z "$owned" ]] \
      || fail "cleanup: StateStore still has owned services: $(printf '%s' "$owned" | tr '\n' ' ')"
  fi

  leftovers="$(find "$UNIT_DIR" -maxdepth 1 -name 'zm2-compose-e2e-*' -print -quit 2>/dev/null || true)"
  [[ -z "$leftovers" ]] || fail "cleanup left unit resources: $leftovers"
  leftovers="$(find "$ENV_DIR" -maxdepth 1 -name 'zm2-compose-e2e-*' -print -quit 2>/dev/null || true)"
  [[ -z "$leftovers" ]] || fail "cleanup left environment resources: $leftovers"
  leftovers="$(find "$WANTS_DIR" -maxdepth 1 -name 'zm2-compose-e2e-*' -print -quit 2>/dev/null || true)"
  [[ -z "$leftovers" ]] || fail "cleanup left enablement resources: $leftovers"
  leftovers="$(systemctl list-unit-files --no-legend --no-pager 'zm2-compose-e2e-*' 2>/dev/null || true)"
  [[ -z "$leftovers" ]] || fail "cleanup left systemd unit files: $leftovers"
  leftovers="$(systemctl list-units --all --no-legend --no-pager 'zm2-compose-e2e-*')"
  [[ -z "$leftovers" ]] || fail "cleanup left loaded systemd units: $leftovers"

  [[ "$failures" -eq 0 ]] \
    || fail "cleanup could not delete $failures owned app(s); resources retained for diagnosis"

  ok "cleanup: all owned units, env files, state entries and drop-ins removed"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

main() {
  PHASE="${1:-}"

  case "$PHASE" in
    backend|lifecycle|prepare-boot|verify-boot|no-rollback|cleanup) ;;
    *)
      fail "Usage: $0 {backend|lifecycle|prepare-boot|verify-boot|no-rollback|cleanup}"
      ;;
  esac

  enable_err_trap

  # All guards are read-only. Nothing is created before this returns.
  require_e2e_environment
  setup_evidence

  case "$PHASE" in
    backend) phase_backend ;;
    lifecycle) phase_lifecycle ;;
    prepare-boot) phase_prepare_boot ;;
    verify-boot) phase_verify_boot ;;
    no-rollback) phase_no_rollback ;;
    cleanup) phase_cleanup ;;
  esac
}

main "$@"
