#!/usr/bin/env bash
#
# Real Linux/systemd/nvm integration test for `zm2 update-node`.
#
# This test is destructive only to the apps it creates. It requires an explicit
# opt-in, a trusted existing nvm, a fresh empty test ZM2 home, and two real
# distinct Node versions already known to the operator.
#
# Linux invocation (do not run on production):
#
#   export NVM_DIR=/home/test/.nvm
#   export ZM2_NODE_OLD=20.11.1
#   export ZM2_NODE_TARGET=22.14.0
#   export ZM2_HOME="$(mktemp -d /tmp/zm2-update-node-e2e.XXXXXX)"
#   sudo env ZM2_UPDATE_NODE_E2E=1 \
#     NVM_DIR="$NVM_DIR" ZM2_HOME="$ZM2_HOME" \
#     ZM2_NODE_OLD="$ZM2_NODE_OLD" ZM2_NODE_TARGET="$ZM2_NODE_TARGET" \
#     bash test/e2e/systemd/update-node.sh
#
# The script creates a nested mktemp home below ZM2_HOME and removes only that
# nested path. ZM2_HOME must be an existing empty directory. The target runtime
# may be installed by update-node itself; it is never installed by this script.
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)"
ZM2_BIN="$REPO_ROOT/bin/zm2"
FIXTURES="$REPO_ROOT/test/fixtures/update-node"

STABLE_APP="update-node-e2e-stable"
INCOMPAT_APP="update-node-e2e-incompatible"
STOPPED_APP="update-node-e2e-stopped"
MIXED_APP="update-node-e2e-mixed"

STABLE_SVC="zm2-$STABLE_APP"
INCOMPAT_SVC="zm2-$INCOMPAT_APP"
STOPPED_SVC="zm2-$STOPPED_APP"
MIXED_SVC="zm2-$MIXED_APP"

ALL_SERVICES=("$STABLE_SVC" "$INCOMPAT_SVC" "$STOPPED_SVC" "$MIXED_SVC")
ALL_INSTANCES=(1 1 1 2)
AFTER_DELETE_SERVICES=("$STABLE_SVC" "$STOPPED_SVC" "$MIXED_SVC")

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM:-0}"

E2E_ROOT=""
TEST_ZM2_HOME=""
E2E_OS_HOME=""
STATE_FILE=""
REPORT1=""
REPORT2=""
CLI_NODE=""
NVM_DIR="${NVM_DIR:-}"
ZM2_HOME="${ZM2_HOME:-}"
OLD_VERSION=""
TARGET_VERSION=""
OLD_NODE=""
TARGET_NODE=""
TARGET_BIN=""
ALIAS_BEFORE=""
CLEANUP_DONE=0
CLEANED_ANY=0
CREATION_STARTED=0

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
  local svc="$1"
  local instances="$2"

  if [[ "$instances" -gt 1 ]]; then
    printf '/etc/systemd/system/%s@.service' "$svc"
  else
    printf '/etc/systemd/system/%s.service' "$svc"
  fi
}

env_path_for() {
  printf '/etc/zm2/env/%s.env' "$1"
}

unit_file_for_unit() {
  local unit="$1"

  if [[ "$unit" == *"@"* ]]; then
    printf '/etc/systemd/system/%s@.service' "${unit%%@*}"
  else
    printf '/etc/systemd/system/%s.service' "$unit"
  fi
}

unit_pid() {
  local value
  value="$(systemctl show -p MainPID --value "$1.service" 2>/dev/null || true)"
  printf '%s' "${value//[[:space:]]/}"
}

unit_active_state() {
  systemctl show -p ActiveState --value "$1.service" 2>/dev/null || true
}

unit_sub_state() {
  systemctl show -p SubState --value "$1.service" 2>/dev/null || true
}

unit_nrestarts() {
  local value
  value="$(systemctl show -p NRestarts --value "$1.service" 2>/dev/null || true)"
  printf '%s' "${value//[[:space:]]/}"
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

state_keys_file() {
  local file="$1"

  "$CLI_NODE" -e '
    var fs = require("fs");
    var data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    var services = data.services || {};
    Object.keys(services).forEach(function(key) { console.log(key); });
  ' "$file"
}

state_get() {
  local svc="$1"
  local key="$2"

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
  ' "$STATE_FILE" "$svc" "$key"
}

state_entry_canonical() {
  local svc="$1"

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
  ' "$STATE_FILE" "$svc"
}

stat_signature() {
  stat -c '%a %u %g' -- "$1"
}

alias_signature() {
  local alias_file="$NVM_DIR/alias/default"

  if [[ ! -e "$alias_file" && ! -L "$alias_file" ]]; then
    printf 'absent\n'
    return 0
  fi

  printf 'present\n'
  stat -c 'type=%F mode=%a uid=%u gid=%g size=%s' -- "$alias_file"

  if [[ -L "$alias_file" ]]; then
    printf 'symlink=%s\n' "$(readlink -- "$alias_file")"
  elif [[ -f "$alias_file" ]]; then
    printf 'bytes=%s\n' "$(od -An -v -tx1 "$alias_file" | tr -d ' \n')"
  else
    printf 'other\n'
  fi
}

run_zm2() {
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
    HOME="$E2E_OS_HOME" \
    ZM2_HOME="$TEST_ZM2_HOME" \
    PM2_HOME="$TEST_ZM2_HOME" \
    NVM_DIR="$NVM_DIR" \
    ZM2_UPDATE_NODE_E2E_RUN_ID="$RUN_ID" \
    "$CLI_NODE" "$ZM2_BIN" "$@" </dev/null
}

create_app() {
  local name="$1"
  local script="$2"
  local instances="$3"
  shift 3

  info "Creating $name on Node v$OLD_VERSION ($instances instance(s))"
  ZM2_NODE_TARGET="$TARGET_VERSION" run_zm2 start "$FIXTURES/$script" \
    --name "$name" \
    --interpreter "$OLD_NODE" \
    --cwd "$FIXTURES" \
    --instances "$instances" \
    "$@"
}

wait_active() {
  local unit="$1"
  local attempts="${2:-100}"
  local i

  for ((i = 0; i < attempts; i++)); do
    if systemctl is-active --quiet "$unit.service"; then
      return 0
    fi
    sleep 0.1
  done

  fail "unit $unit did not become active"
}

wait_inactive() {
  local unit="$1"
  local attempts="${2:-100}"
  local i

  for ((i = 0; i < attempts; i++)); do
    if ! systemctl is-active --quiet "$unit.service"; then
      return 0
    fi
    sleep 0.1
  done

  fail "unit $unit did not become inactive"
}

wait_pid_zero() {
  local unit="$1"
  local attempts="${2:-100}"
  local i
  local pid

  for ((i = 0; i < attempts; i++)); do
    pid="$(unit_pid "$unit")"
    if [[ "$pid" == "0" ]]; then
      return 0
    fi
    sleep 0.1
  done

  fail "unit $unit still has MainPID '$pid'"
}

assert_runtime() {
  local label="$1"
  local executable="$2"
  local version="$3"
  local actual

  [[ -f "$executable" && -x "$executable" ]] \
    || fail "$label: executable is missing or not executable: $executable"

  actual="$("$executable" --version 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$actual" == "v$version" ]] \
    || fail "$label: expected v$version, got '$actual'"
}

assert_same_executable() {
  local label="$1"
  local actual="$2"
  local expected="$3"
  local actual_real
  local expected_real

  [[ -n "$actual" ]] || fail "$label: empty executable path"
  [[ -n "$expected" ]] || fail "$label: empty expected executable path"

  actual_real="$(realpath -- "$actual" 2>/dev/null || printf '%s' "$actual")"
  expected_real="$(realpath -- "$expected" 2>/dev/null || printf '%s' "$expected")"

  [[ "$actual_real" == "$expected_real" ]] \
    || fail "$label: expected $expected_real, got $actual_real"
}

assert_unit_exec() {
  local label="$1"
  local unit="$2"
  local expected="$3"
  local effective

  effective="$(unit_exec_path "$unit")"
  [[ -n "$effective" ]] \
    || fail "$label: systemctl show did not expose an ExecStart path for $unit"

  assert_same_executable "$label ExecStart" "$effective" "$expected"
}

assert_unit_contains() {
  local label="$1"
  local unit_path="$2"
  local expected="$3"

  [[ -f "$unit_path" ]] || fail "$label: unit file is missing: $unit_path"
  grep -Fq "$expected" "$unit_path" \
    || fail "$label: unit file is missing expected line '$expected'"
}

assert_preserved_unit_directives() {
  local label="$1"
  local svc="$2"
  local instances="$3"
  local unit_path

  unit_path="$(unit_path_for "$svc" "$instances")"

  assert_unit_contains "$label WorkingDirectory" "$unit_path" "WorkingDirectory=$FIXTURES"
  assert_unit_contains "$label Restart" "$unit_path" "Restart=on-failure"
  assert_unit_contains "$label LimitNOFILE" "$unit_path" "LimitNOFILE=65536"
  assert_unit_contains "$label EnvironmentFile" "$unit_path" "EnvironmentFile=-/etc/zm2/env/$svc.env"

  if [[ "$instances" -gt 1 ]]; then
    assert_unit_contains "$label instance environment" "$unit_path" "Environment=NODE_APP_INSTANCE=%i"
  fi
}

assert_unit_file_exec() {
  local label="$1"
  local unit_path="$2"
  local expected="$3"
  local line

  [[ -f "$unit_path" ]] || fail "$label: unit file is missing: $unit_path"

  line="$(grep -m1 '^ExecStart=' "$unit_path" || true)"
  [[ -n "$line" ]] || fail "$label: no ExecStart line in $unit_path"

  if [[ "$expected" == *[[:space:]]* ]]; then
    info "$label: runtime path contains whitespace; using parsed systemctl ExecStart only"
    return 0
  fi

  case "$line" in
    "ExecStart=$expected"|"ExecStart=$expected "*) ;;
    *) fail "$label: unit file ExecStart does not start with $expected: $line" ;;
  esac
}

assert_active_with_exec() {
  local label="$1"
  local unit="$2"
  local expected="$3"
  local state
  local sub
  local pid
  local exe

  state="$(unit_active_state "$unit")"
  sub="$(unit_sub_state "$unit")"
  pid="$(unit_pid "$unit")"

  [[ "$state" == "active" ]] \
    || fail "$label: expected ActiveState=active, got '$state'"
  [[ "$sub" == "running" ]] \
    || fail "$label: expected SubState=running, got '$sub'"
  [[ "$pid" =~ ^[0-9]+$ ]] || fail "$label: invalid MainPID '$pid'"
  [[ "$pid" -gt 0 ]] || fail "$label: expected a positive MainPID, got $pid"

  exe="$(readlink -f -- "/proc/$pid/exe" 2>/dev/null || true)"
  [[ -n "$exe" ]] || fail "$label: cannot resolve /proc/$pid/exe"

  assert_same_executable "$label process executable" "$exe" "$expected"
  assert_unit_exec "$label unit" "$unit" "$expected"
  assert_unit_file_exec "$label unit file" "$(unit_file_for_unit "$unit")" "$expected"
}

assert_stopped_with_config() {
  local label="$1"
  local unit="$2"
  local svc="$3"
  local expected="$4"
  local version="${5:-}"
  local state
  local pid

  state="$(unit_active_state "$unit")"
  pid="$(unit_pid "$unit")"

  [[ "$state" == "inactive" ]] \
    || fail "$label: expected ActiveState=inactive, got '$state'"
  [[ "$pid" == "0" ]] || fail "$label: expected MainPID=0, got '$pid'"

  assert_unit_exec "$label unit" "$unit" "$expected"
  assert_unit_file_exec "$label unit file" "$(unit_file_for_unit "$unit")" "$expected"
  assert_state_exec "$label" "$svc" "$expected" "$version"
}

assert_enabled_state() {
  local label="$1"
  local unit="$2"
  local expected="$3"
  local enabled=0

  if systemctl is-enabled --quiet "$unit.service"; then
    enabled=1
  fi

  [[ "$enabled" -eq "$expected" ]] \
    || fail "$label: expected enabled=$expected for $unit, got enabled=$enabled"
}

assert_state_exec() {
  local label="$1"
  local svc="$2"
  local expected="$3"
  local version="${4:-}"
  local value

  if ! value="$(state_get "$svc" exec_interpreter)"; then
    fail "$label: StateStore entry $svc has no exec_interpreter"
  fi

  # StateStore may persist the resolved executable or the supported
  # node@<version> interpreter form. Both identify the requested runtime.
  if [[ -n "$version" && ( "$value" == "node@$version" || "$value" == "node@v$version" ) ]]; then
    return 0
  fi

  assert_same_executable "$label StateStore exec_interpreter" "$value" "$expected"
}

assert_state_value() {
  local label="$1"
  local svc="$2"
  local key="$3"
  local expected="$4"
  local value

  if ! value="$(state_get "$svc" "$key")"; then
    fail "$label: StateStore entry $svc has no $key"
  fi

  [[ "$value" == "$expected" ]] \
    || fail "$label: expected StateStore $key=$expected, got $value"
}

assert_preserved_state_metadata() {
  local label="$1"
  local svc="$2"
  local script="$3"
  local instances="$4"

  assert_state_value "$label name" "$svc" name "${svc#zm2-}"
  assert_state_value "$label script" "$svc" script "$FIXTURES/$script"
  assert_state_value "$label cwd" "$svc" cwd "$FIXTURES"
  assert_state_value "$label instances" "$svc" instances "$instances"
}

assert_state_services() {
  local actual
  local expected

  [[ -f "$STATE_FILE" ]] || fail "StateStore file is missing: $STATE_FILE"

  if ! actual="$(state_keys_file "$STATE_FILE")"; then
    fail "StateStore is not valid JSON: $STATE_FILE"
  fi

  actual="$(printf '%s\n' "$actual" | sed '/^$/d' | sort)"
  expected="$(printf '%s\n' "$@" | sed '/^$/d' | sort)"

  if [[ "$actual" != "$expected" ]]; then
    fail "StateStore services do not match the test apps. expected=[$(printf '%s' "$expected" | tr '\n' ' ')] actual=[$(printf '%s' "$actual" | tr '\n' ' ')]"
  fi
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

assert_env_contains() {
  local label="$1"
  local env_file="$2"
  local expected="$3"

  [[ -f "$env_file" ]] || fail "$label: environment file is missing: $env_file"
  grep -Fq "$expected" "$env_file" \
    || fail "$label: environment file is missing '$expected'"
}

assert_file_bytes_equal() {
  local label="$1"
  local before="$2"
  local after="$3"

  [[ -f "$before" ]] || fail "$label: missing before snapshot $before"
  [[ -f "$after" ]] || fail "$label: missing file $after"

  if ! cmp -s -- "$before" "$after"; then
    fail "$label: file bytes changed unexpectedly: $after"
  fi
}

assert_value_equal() {
  local label="$1"
  local before="$2"
  local after="$3"

  [[ "$before" == "$after" ]] \
    || fail "$label: expected '$before', got '$after'"
}

assert_file_stat_preserved() {
  local label="$1"
  local path="$2"
  local before="$3"
  local after

  if ! after="$(stat_signature "$path")"; then
    fail "$label: cannot stat $path"
  fi

  assert_value_equal "$label" "$before" "$after"
}

unit_is_ours() {
  local unit_path="$1"

  [[ -f "$unit_path" ]] || return 1
  grep -Fq 'Description=ZM2: update-node-e2e-' "$unit_path" || return 1
  grep -Fq "$FIXTURES/" "$unit_path" || return 1
  return 0
}

remove_wants_link() {
  local unit="$1"
  local expected_target="$2"
  local link="/etc/systemd/system/multi-user.target.wants/$unit.service"
  local resolved
  local expected_real

  [[ -L "$link" ]] || return 0

  resolved="$(readlink -f -- "$link" 2>/dev/null || true)"
  expected_real="$(readlink -f -- "$expected_target" 2>/dev/null || printf '%s' "$expected_target")"

  if [[ "$resolved" == "$expected_real" ]]; then
    rm -f -- "$link"
  else
    warn "not removing unexpected wants symlink $link -> ${resolved:-unknown}"
  fi
}

cleanup_one_service() {
  local svc="$1"
  local instances="$2"
  local unit_path
  local env_path
  local i

  unit_path="$(unit_path_for "$svc" "$instances")"
  env_path="$(env_path_for "$svc")"

  if ! unit_is_ours "$unit_path"; then
    if [[ -f "$env_path" ]] && grep -Fq "ZM2_UPDATE_NODE_E2E_RUN_ID=$RUN_ID" "$env_path"; then
      rm -f -- "$env_path"
      CLEANED_ANY=1
    fi
    return 0
  fi

  info "Removing test service $svc"

  if [[ "$instances" -gt 1 ]]; then
    for ((i = 0; i < instances; i++)); do
      systemctl stop "$svc@$i.service" >/dev/null 2>&1 || true
      systemctl disable "$svc@$i.service" >/dev/null 2>&1 || true
      remove_wants_link "$svc@$i" "$unit_path"
    done
  else
    systemctl stop "$svc.service" >/dev/null 2>&1 || true
    systemctl disable "$svc.service" >/dev/null 2>&1 || true
    remove_wants_link "$svc" "$unit_path"
  fi

  rm -f -- "$unit_path"
  rm -f -- "$env_path"
  CLEANED_ANY=1
}

cleanup_test_home() {
  local state
  local keys
  local key

  if [[ -z "${E2E_ROOT:-}" || -z "${ZM2_HOME:-}" || -z "${TEST_ZM2_HOME:-}" ]]; then
    return 0
  fi

  case "$E2E_ROOT" in
    "$ZM2_HOME"/zm2-update-node-e2e.*) ;;
    *)
      warn "refusing to remove unexpected test root: $E2E_ROOT"
      return 0
      ;;
  esac

  state="$TEST_ZM2_HOME/state.json"

  if [[ -f "$state" ]]; then
    if [[ -z "${CLI_NODE:-}" || ! -x "${CLI_NODE:-}" ]]; then
      warn "cannot inspect test StateStore; leaving $E2E_ROOT for manual cleanup"
      return 0
    fi

    if ! keys="$(state_keys_file "$state")"; then
      warn "cannot parse test StateStore; leaving $E2E_ROOT for manual cleanup"
      return 0
    fi

    while IFS= read -r key; do
      [[ -z "$key" ]] && continue
      case "$key" in
        zm2-update-node-e2e-*) ;;
        *)
          warn "test StateStore contains unrelated service '$key'; leaving $E2E_ROOT"
          return 0
          ;;
      esac
    done <<< "$keys"
  fi

  info "Removing test ZM2 home $E2E_ROOT"
  rm -rf -- "$E2E_ROOT"
}

remove_created_resources() {
  local i

  if [[ "$CREATION_STARTED" == "1" ]]; then
    for i in "${!ALL_SERVICES[@]}"; do
      cleanup_one_service "${ALL_SERVICES[$i]}" "${ALL_INSTANCES[$i]}"
    done
  fi

  if [[ "$CLEANED_ANY" == "1" ]]; then
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi

  cleanup_test_home
}

cleanup() {
  local status=$?

  trap - EXIT INT TERM HUP ERR

  if [[ "${CLEANUP_DONE:-0}" == "1" ]]; then
    exit "$status"
  fi

  CLEANUP_DONE=1
  set +e
  set +u

  info "Cleaning up test resources (exit status $status)"
  remove_created_resources

  exit "$status"
}

assert_no_test_resources_left() {
  local i
  local svc
  local instances
  local path
  local dir
  local found

  for i in "${!ALL_SERVICES[@]}"; do
    svc="${ALL_SERVICES[$i]}"
    instances="${ALL_INSTANCES[$i]}"
    path="$(unit_path_for "$svc" "$instances")"
    if [[ -e "$path" || -L "$path" ]]; then
      fail "cleanup left unit file: $path"
    fi

    path="$(env_path_for "$svc")"
    if [[ -e "$path" || -L "$path" ]]; then
      fail "cleanup left environment file: $path"
    fi
  done

  if [[ -n "${E2E_ROOT:-}" && ( -e "$E2E_ROOT" || -L "$E2E_ROOT" ) ]]; then
    fail "cleanup left the test home: $E2E_ROOT"
  fi

  if [[ -n "${ZM2_HOME:-}" && -d "$ZM2_HOME" ]]; then
    found="$(find "$ZM2_HOME" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)"
    [[ -z "$found" ]] || fail "cleanup left files in ZM2_HOME: $found"
  fi

  for dir in /etc/systemd/system /etc/systemd/system/multi-user.target.wants /etc/zm2/env; do
    [[ -d "$dir" ]] || continue
    found="$(find "$dir" -maxdepth 1 -name 'zm2-update-node-e2e-*' -print -quit 2>/dev/null || true)"
    [[ -z "$found" ]] || fail "cleanup left a test-prefixed resource: $found"
  done

  found="$(systemctl list-unit-files --no-legend --no-pager 'zm2-update-node-e2e-*' 2>/dev/null || true)"
  [[ -z "$found" ]] || fail "cleanup left systemd unit files: $found"
}

verify_unit() {
  local unit_name="$1"
  local output
  local rc

  info "Validating $unit_name with systemd-analyze verify"

  trap - ERR
  set +e
  output="$(systemd-analyze verify "$unit_name" 2>&1)"
  rc=$?
  set -e
  enable_err_trap

  if [[ -n "$output" ]]; then
    printf '%s\n' "$output"
  fi

  if printf '%s\n' "$output" | grep -Fq 'zm2-update-node-e2e-'; then
    fail "systemd-analyze verify reported diagnostics for test unit $unit_name (exit $rc)"
  fi

  if [[ "$rc" -ne 0 ]]; then
    if [[ -z "$output" ]]; then
      fail "systemd-analyze verify failed for $unit_name without diagnostics"
    fi
    warn "systemd-analyze verify exited $rc for $unit_name with diagnostics that do not name test units; treating them as unrelated"
  fi
}

main() {
  local missing=()
  local platform
  local nvm_sh
  local nvm_mode
  local nvm_owner
  local path_node
  local cli_major
  local default_home
  local existing
  local dir
  local collision
  local rc
  local svc
  local incompat_unit_before
  local incompat_env_before
  local incompat_state_before
  local incompat_unit_stat_before
  local incompat_env_stat_before
  local incompat_unit_stat_after
  local incompat_env_stat_after
  local stable_unit_stat_before
  local stable_env_stat_before
  local stopped_unit_stat_before
  local stopped_env_stat_before
  local mixed_unit_stat_before
  local mixed_env_stat_before
  local alias_after_first
  local alias_after_second
  local pid_stable_after_first
  local pid_mixed0_after_first
  local nrestarts_stable_after_first
  local nrestarts_mixed0_after_first

  if [[ "${ZM2_UPDATE_NODE_E2E:-}" != "1" ]]; then
    fail "Refusing to run: set ZM2_UPDATE_NODE_E2E=1 to opt in to this destructive integration test"
  fi

  [[ -n "${NVM_DIR:-}" ]] || missing+=("NVM_DIR")
  [[ -n "${ZM2_HOME:-}" ]] || missing+=("ZM2_HOME")
  [[ -n "${ZM2_NODE_OLD:-}" ]] || missing+=("ZM2_NODE_OLD")
  [[ -n "${ZM2_NODE_TARGET:-}" ]] || missing+=("ZM2_NODE_TARGET")

  if [[ "${#missing[@]}" -gt 0 ]]; then
    fail "Missing required environment variable(s): ${missing[*]}"
  fi

  platform="$(uname -s)"
  if [[ "$platform" != "Linux" ]]; then
    fail "Refusing to run integration test on $platform: requires Linux with systemd and root privileges"
  fi

  if [[ "$(id -u)" -ne 0 ]]; then
    fail "Refusing to run: this integration test requires root privileges"
  fi

  [[ -d /run/systemd/system ]] \
    || fail "Refusing to run: systemd is not running (/run/systemd/system is missing)"
  command -v systemctl >/dev/null 2>&1 \
    || fail "Refusing to run: systemctl is not available"
  command -v systemd-analyze >/dev/null 2>&1 \
    || fail "Refusing to run: systemd-analyze is not available"
  [[ -d /etc/systemd/system && -w /etc/systemd/system ]] \
    || fail "Refusing to run: /etc/systemd/system is missing or not writable"

  if ! systemctl show --property=Version >/dev/null 2>&1; then
    fail "Refusing to run: systemd is not responding to systemctl"
  fi

  [[ -f "$ZM2_BIN" ]] || fail "local ZM2 CLI not found: $ZM2_BIN"
  [[ -f "$FIXTURES/stable.js" ]] || fail "fixture not found: $FIXTURES/stable.js"
  [[ -f "$FIXTURES/fail-on-target.js" ]] || fail "fixture not found: $FIXTURES/fail-on-target.js"

  if ! OLD_VERSION="$(normalize_version "$ZM2_NODE_OLD")"; then
    fail "ZM2_NODE_OLD must be an exact major.minor.patch version (optional v prefix): $ZM2_NODE_OLD"
  fi
  if ! TARGET_VERSION="$(normalize_version "$ZM2_NODE_TARGET")"; then
    fail "ZM2_NODE_TARGET must be an exact major.minor.patch version (optional v prefix): $ZM2_NODE_TARGET"
  fi

  [[ "$OLD_VERSION" != "$TARGET_VERSION" ]] \
    || fail "ZM2_NODE_OLD and ZM2_NODE_TARGET must be different versions after normalization"

  if [[ "$NVM_DIR" != /* ]]; then
    fail "NVM_DIR must be an absolute path: $NVM_DIR"
  fi
  [[ -d "$NVM_DIR" ]] || fail "NVM_DIR is not a directory: $NVM_DIR"
  NVM_DIR="$(realpath -- "$NVM_DIR")"
  [[ "$NVM_DIR" != "/" ]] || fail "NVM_DIR must not be /"

  nvm_sh="$NVM_DIR/nvm.sh"
  [[ -f "$nvm_sh" && -r "$nvm_sh" ]] \
    || fail "trusted nvm.sh not found or not readable: $nvm_sh"

  if ! nvm_mode="$(stat -Lc '%a' "$nvm_sh" 2>/dev/null)"; then
    fail "cannot stat nvm.sh: $nvm_sh"
  fi
  if (( (8#$nvm_mode & 8#022) != 0 )); then
    fail "refusing to source group/world-writable nvm.sh (mode $nvm_mode): $nvm_sh"
  fi

  if ! nvm_owner="$(stat -Lc '%u' "$nvm_sh" 2>/dev/null)"; then
    fail "cannot stat owner of nvm.sh: $nvm_sh"
  fi
  if [[ "$nvm_owner" != "0" ]]; then
    warn "nvm.sh is owned by uid $nvm_owner; this test will source it as root. Continue only if you trust that nvm."
  fi

  OLD_NODE="$NVM_DIR/versions/node/v$OLD_VERSION/bin/node"
  TARGET_NODE="$NVM_DIR/versions/node/v$TARGET_VERSION/bin/node"
  TARGET_BIN="$NVM_DIR/versions/node/v$TARGET_VERSION/bin"

  assert_runtime "old runtime" "$OLD_NODE" "$OLD_VERSION"

  if [[ -e "$TARGET_NODE" ]]; then
    assert_runtime "target runtime" "$TARGET_NODE" "$TARGET_VERSION"
  else
    info "Target runtime v$TARGET_VERSION is not installed; update-node must install it."
  fi

  path_node="$(type -P node || true)"
  if [[ -n "$path_node" ]]; then
    CLI_NODE="$(realpath -- "$path_node")"
  else
    CLI_NODE="$(realpath -- "$OLD_NODE")"
  fi
  [[ -x "$CLI_NODE" ]] || fail "cannot find an executable CLI Node"

  cli_major="$("$CLI_NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  [[ "$cli_major" =~ ^[0-9]+$ && "$cli_major" -ge 16 ]] \
    || fail "CLI Node must be Node.js >= 16, got '$cli_major' from $CLI_NODE"

  info "Using CLI Node $CLI_NODE (selected before update-node changes nvm)"

  if [[ "$ZM2_HOME" != /* ]]; then
    fail "ZM2_HOME must be an absolute path: $ZM2_HOME"
  fi
  [[ -d "$ZM2_HOME" ]] \
    || fail "ZM2_HOME must be an existing empty test directory: $ZM2_HOME"
  ZM2_HOME="$(realpath -- "$ZM2_HOME")"
  [[ "$ZM2_HOME" != "/" ]] || fail "ZM2_HOME must not be /"

  default_home="$(realpath -m -- "${HOME:-/root}/.zm2")"
  if [[ "$ZM2_HOME" == "$default_home" || "$ZM2_HOME" == "/root/.zm2" || "$ZM2_HOME" == "/etc/.zm2" ]]; then
    fail "refusing to use the default or production ZM2 home: $ZM2_HOME"
  fi

  existing="$(find "$ZM2_HOME" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)"
  [[ -z "$existing" ]] \
    || fail "ZM2_HOME must be a fresh empty test directory; found $existing"

  for dir in /etc/systemd/system /etc/systemd/system/multi-user.target.wants /etc/zm2/env; do
    [[ -d "$dir" ]] || continue
    collision="$(find "$dir" -maxdepth 1 -name 'zm2-update-node-e2e-*' -print -quit 2>/dev/null || true)"
    [[ -z "$collision" ]] \
      || fail "refusing to run: existing test-prefixed system resource: $collision"
  done

  collision="$(systemctl list-unit-files --no-legend --no-pager 'zm2-update-node-e2e-*' 2>/dev/null || true)"
  [[ -z "$collision" ]] \
    || fail "refusing to run: systemd already knows test-prefixed units: $collision"

  E2E_ROOT="$(mktemp -d "$ZM2_HOME/zm2-update-node-e2e.XXXXXXXX")" \
    || fail "cannot create a nested test directory under $ZM2_HOME"
  TEST_ZM2_HOME="$E2E_ROOT/home"
  E2E_OS_HOME="$E2E_ROOT/os-home"
  STATE_FILE="$TEST_ZM2_HOME/state.json"
  REPORT1="$E2E_ROOT/report-first.txt"
  REPORT2="$E2E_ROOT/report-second.txt"

  mkdir -m 700 "$TEST_ZM2_HOME" "$E2E_OS_HOME"
  info "Test ZM2 home: $TEST_ZM2_HOME"

  CREATION_STARTED=1

  create_app "$STABLE_APP" stable.js 1
  create_app "$INCOMPAT_APP" fail-on-target.js 1 --no-autorestart
  create_app "$STOPPED_APP" stable.js 1
  create_app "$MIXED_APP" stable.js 2

  wait_active "$STABLE_SVC"
  wait_active "$INCOMPAT_SVC"
  wait_active "$STOPPED_SVC"
  wait_active "$MIXED_SVC@0"
  wait_active "$MIXED_SVC@1"

  info "Stopping $STOPPED_SVC through the ZM2 CLI"
  run_zm2 stop "$STOPPED_APP"
  wait_inactive "$STOPPED_SVC"
  wait_pid_zero "$STOPPED_SVC"

  info "Stopping only $MIXED_SVC@1 with systemctl"
  systemctl stop "$MIXED_SVC@1.service"
  wait_inactive "$MIXED_SVC@1"
  wait_pid_zero "$MIXED_SVC@1"
  wait_active "$MIXED_SVC@0"

  assert_state_services "${ALL_SERVICES[@]}"
  assert_preserved_state_metadata "initial stable" "$STABLE_SVC" stable.js 1
  assert_preserved_state_metadata "initial stopped" "$STOPPED_SVC" stable.js 1
  assert_preserved_state_metadata "initial mixed" "$MIXED_SVC" stable.js 2

  assert_active_with_exec "initial stable" "$STABLE_SVC" "$OLD_NODE"
  assert_active_with_exec "initial incompatible" "$INCOMPAT_SVC" "$OLD_NODE"
  assert_stopped_with_config "initial stopped" "$STOPPED_SVC" "$STOPPED_SVC" "$OLD_NODE" "$OLD_VERSION"
  assert_active_with_exec "initial mixed instance 0" "$MIXED_SVC@0" "$OLD_NODE"
  assert_stopped_with_config "initial mixed instance 1" "$MIXED_SVC@1" "$MIXED_SVC" "$OLD_NODE" "$OLD_VERSION"

  assert_state_exec "initial stable" "$STABLE_SVC" "$OLD_NODE" "$OLD_VERSION"
  assert_state_exec "initial incompatible" "$INCOMPAT_SVC" "$OLD_NODE" "$OLD_VERSION"
  assert_state_exec "initial stopped" "$STOPPED_SVC" "$OLD_NODE" "$OLD_VERSION"
  assert_state_exec "initial mixed" "$MIXED_SVC" "$OLD_NODE" "$OLD_VERSION"

  assert_enabled_state "initial stable" "$STABLE_SVC" 1
  assert_enabled_state "initial incompatible" "$INCOMPAT_SVC" 1
  assert_enabled_state "initial stopped" "$STOPPED_SVC" 0
  assert_enabled_state "initial mixed instance 0" "$MIXED_SVC@0" 1
  assert_enabled_state "initial mixed instance 1" "$MIXED_SVC@1" 1

  incompat_unit_before="$E2E_ROOT/incompat.unit.before"
  incompat_env_before="$E2E_ROOT/incompat.env.before"
  incompat_state_before="$E2E_ROOT/incompat.state.before"
  incompat_unit_stat_before="$(stat_signature "$(unit_path_for "$INCOMPAT_SVC" 1)")"
  incompat_env_stat_before="$(stat_signature "$(env_path_for "$INCOMPAT_SVC")")"
  stable_unit_stat_before="$(stat_signature "$(unit_path_for "$STABLE_SVC" 1)")"
  stable_env_stat_before="$(stat_signature "$(env_path_for "$STABLE_SVC")")"
  stopped_unit_stat_before="$(stat_signature "$(unit_path_for "$STOPPED_SVC" 1)")"
  stopped_env_stat_before="$(stat_signature "$(env_path_for "$STOPPED_SVC")")"
  mixed_unit_stat_before="$(stat_signature "$(unit_path_for "$MIXED_SVC" 2)")"
  mixed_env_stat_before="$(stat_signature "$(env_path_for "$MIXED_SVC")")"

  cp -- "$(unit_path_for "$INCOMPAT_SVC" 1)" "$incompat_unit_before"
  cp -- "$(env_path_for "$INCOMPAT_SVC")" "$incompat_env_before"
  if ! state_entry_canonical "$INCOMPAT_SVC" > "$incompat_state_before"; then
    fail "cannot snapshot the incompatible app StateStore entry"
  fi

  ALIAS_BEFORE="$(alias_signature)"

  info "Running: zm2 update-node $TARGET_VERSION (expected exit code 1 because $INCOMPAT_SVC cannot start on target)"
  trap - ERR
  set +e
  run_zm2 update-node "$TARGET_VERSION" >"$REPORT1" 2>&1
  rc=$?
  set -e
  enable_err_trap

  info "First update-node exit code: $rc"
  printf '%s\n' '--- update-node report (first run) ---'
  cat "$REPORT1"
  printf '%s\n' '--- end report ---'

  [[ "$rc" -eq 1 ]] \
    || fail "expected the first update-node run to exit 1 because of $INCOMPAT_SVC, got $rc"
  [[ -s "$REPORT1" ]] || fail "first update-node report is empty"
  grep -Fq "$TARGET_VERSION" "$REPORT1" \
    || fail "first report does not mention requested version $TARGET_VERSION"
  for svc in "${ALL_SERVICES[@]}"; do
    grep -Fq "$svc" "$REPORT1" || fail "first report does not mention $svc"
  done

  assert_runtime "target runtime after first run" "$TARGET_NODE" "$TARGET_VERSION"

  assert_active_with_exec "stable after first run" "$STABLE_SVC" "$TARGET_NODE"
  assert_state_exec "stable after first run" "$STABLE_SVC" "$TARGET_NODE" "$TARGET_VERSION"
  assert_env_path_prefixed "stable after first run" "$(env_path_for "$STABLE_SVC")" "$TARGET_BIN"
  assert_env_contains "stable after first run" "$(env_path_for "$STABLE_SVC")" "ZM2_NODE_TARGET=$TARGET_VERSION"
  assert_env_contains "stable after first run" "$(env_path_for "$STABLE_SVC")" "ZM2_UPDATE_NODE_E2E_RUN_ID=$RUN_ID"
  assert_enabled_state "stable after first run" "$STABLE_SVC" 1

  assert_active_with_exec "incompatible after rollback" "$INCOMPAT_SVC" "$OLD_NODE"
  assert_state_exec "incompatible after rollback" "$INCOMPAT_SVC" "$OLD_NODE" "$OLD_VERSION"
  assert_enabled_state "incompatible after rollback" "$INCOMPAT_SVC" 1
  assert_file_bytes_equal "incompatible unit after rollback" "$incompat_unit_before" "$(unit_path_for "$INCOMPAT_SVC" 1)"
  assert_file_bytes_equal "incompatible environment after rollback" "$incompat_env_before" "$(env_path_for "$INCOMPAT_SVC")"
  incompat_unit_stat_after="$(stat_signature "$(unit_path_for "$INCOMPAT_SVC" 1)")"
  incompat_env_stat_after="$(stat_signature "$(env_path_for "$INCOMPAT_SVC")")"
  assert_value_equal "incompatible unit ownership/mode after rollback" "$incompat_unit_stat_before" "$incompat_unit_stat_after"
  assert_value_equal "incompatible environment ownership/mode after rollback" "$incompat_env_stat_before" "$incompat_env_stat_after"

  if ! state_entry_canonical "$INCOMPAT_SVC" > "$E2E_ROOT/incompat.state.after"; then
    fail "cannot read the incompatible app StateStore entry after rollback"
  fi
  assert_file_bytes_equal "incompatible StateStore entry after rollback" "$incompat_state_before" "$E2E_ROOT/incompat.state.after"

  assert_stopped_with_config "stopped after first run" "$STOPPED_SVC" "$STOPPED_SVC" "$TARGET_NODE" "$TARGET_VERSION"
  assert_env_path_prefixed "stopped after first run" "$(env_path_for "$STOPPED_SVC")" "$TARGET_BIN"
  assert_env_contains "stopped after first run" "$(env_path_for "$STOPPED_SVC")" "ZM2_NODE_TARGET=$TARGET_VERSION"
  assert_env_contains "stopped after first run" "$(env_path_for "$STOPPED_SVC")" "ZM2_UPDATE_NODE_E2E_RUN_ID=$RUN_ID"
  assert_enabled_state "stopped after first run" "$STOPPED_SVC" 0

  assert_active_with_exec "mixed instance 0 after first run" "$MIXED_SVC@0" "$TARGET_NODE"
  assert_stopped_with_config "mixed instance 1 after first run" "$MIXED_SVC@1" "$MIXED_SVC" "$TARGET_NODE" "$TARGET_VERSION"
  assert_env_path_prefixed "mixed after first run" "$(env_path_for "$MIXED_SVC")" "$TARGET_BIN"
  assert_env_contains "mixed after first run" "$(env_path_for "$MIXED_SVC")" "ZM2_NODE_TARGET=$TARGET_VERSION"
  assert_env_contains "mixed after first run" "$(env_path_for "$MIXED_SVC")" "ZM2_UPDATE_NODE_E2E_RUN_ID=$RUN_ID"
  assert_enabled_state "mixed instance 0 after first run" "$MIXED_SVC@0" 1
  assert_enabled_state "mixed instance 1 after first run" "$MIXED_SVC@1" 1

  assert_state_services "${ALL_SERVICES[@]}"
  assert_state_exec "mixed after first run" "$MIXED_SVC" "$TARGET_NODE" "$TARGET_VERSION"
  assert_state_exec "stopped after first run" "$STOPPED_SVC" "$TARGET_NODE" "$TARGET_VERSION"
  assert_preserved_state_metadata "stable after first run" "$STABLE_SVC" stable.js 1
  assert_preserved_state_metadata "stopped after first run" "$STOPPED_SVC" stable.js 1
  assert_preserved_state_metadata "mixed after first run" "$MIXED_SVC" stable.js 2

  assert_preserved_unit_directives "stable after first run" "$STABLE_SVC" 1
  assert_preserved_unit_directives "stopped after first run" "$STOPPED_SVC" 1
  assert_preserved_unit_directives "mixed after first run" "$MIXED_SVC" 2

  assert_file_stat_preserved "stable unit ownership/mode after first run" "$(unit_path_for "$STABLE_SVC" 1)" "$stable_unit_stat_before"
  assert_file_stat_preserved "stable environment ownership/mode after first run" "$(env_path_for "$STABLE_SVC")" "$stable_env_stat_before"
  assert_file_stat_preserved "stopped unit ownership/mode after first run" "$(unit_path_for "$STOPPED_SVC" 1)" "$stopped_unit_stat_before"
  assert_file_stat_preserved "stopped environment ownership/mode after first run" "$(env_path_for "$STOPPED_SVC")" "$stopped_env_stat_before"
  assert_file_stat_preserved "mixed unit ownership/mode after first run" "$(unit_path_for "$MIXED_SVC" 2)" "$mixed_unit_stat_before"
  assert_file_stat_preserved "mixed environment ownership/mode after first run" "$(env_path_for "$MIXED_SVC")" "$mixed_env_stat_before"

  alias_after_first="$(alias_signature)"
  assert_value_equal "nvm default alias after first run" "$ALIAS_BEFORE" "$alias_after_first"

  pid_stable_after_first="$(unit_pid "$STABLE_SVC")"
  pid_mixed0_after_first="$(unit_pid "$MIXED_SVC@0")"
  nrestarts_stable_after_first="$(unit_nrestarts "$STABLE_SVC")"
  nrestarts_mixed0_after_first="$(unit_nrestarts "$MIXED_SVC@0")"

  verify_unit "$STABLE_SVC.service"
  verify_unit "$INCOMPAT_SVC.service"
  verify_unit "$STOPPED_SVC.service"
  verify_unit "$MIXED_SVC@0.service"
  verify_unit "$MIXED_SVC@1.service"

  info "Deleting $INCOMPAT_SVC through the ZM2 CLI"
  run_zm2 delete "$INCOMPAT_APP"

  if [[ -e "$(unit_path_for "$INCOMPAT_SVC" 1)" || -L "$(unit_path_for "$INCOMPAT_SVC" 1)" ]]; then
    fail "incompatible unit still exists after delete"
  fi
  if [[ -e "$(env_path_for "$INCOMPAT_SVC")" || -L "$(env_path_for "$INCOMPAT_SVC")" ]]; then
    fail "incompatible environment file still exists after delete"
  fi

  assert_state_services "${AFTER_DELETE_SERVICES[@]}"

  info "Running: zm2 update-node $TARGET_VERSION (expected exit code 0 after removing the incompatible app)"
  trap - ERR
  set +e
  run_zm2 update-node "$TARGET_VERSION" >"$REPORT2" 2>&1
  rc=$?
  set -e
  enable_err_trap

  info "Second update-node exit code: $rc"
  printf '%s\n' '--- update-node report (second run) ---'
  cat "$REPORT2"
  printf '%s\n' '--- end report ---'

  [[ "$rc" -eq 0 ]] \
    || fail "expected the second update-node run to exit 0, got $rc"
  [[ -s "$REPORT2" ]] || fail "second update-node report is empty"
  grep -Fq "$TARGET_VERSION" "$REPORT2" \
    || fail "second report does not mention requested version $TARGET_VERSION"
  for svc in "${AFTER_DELETE_SERVICES[@]}"; do
    grep -Fq "$svc" "$REPORT2" || fail "second report does not mention $svc"
  done
  if grep -Fq "$INCOMPAT_SVC" "$REPORT2"; then
    fail "second report mentions the deleted incompatible service $INCOMPAT_SVC"
  fi

  assert_active_with_exec "stable after second run" "$STABLE_SVC" "$TARGET_NODE"
  assert_active_with_exec "mixed instance 0 after second run" "$MIXED_SVC@0" "$TARGET_NODE"
  assert_stopped_with_config "stopped after second run" "$STOPPED_SVC" "$STOPPED_SVC" "$TARGET_NODE" "$TARGET_VERSION"
  assert_stopped_with_config "mixed instance 1 after second run" "$MIXED_SVC@1" "$MIXED_SVC" "$TARGET_NODE" "$TARGET_VERSION"

  assert_state_services "${AFTER_DELETE_SERVICES[@]}"
  assert_state_exec "stable after second run" "$STABLE_SVC" "$TARGET_NODE" "$TARGET_VERSION"
  assert_state_exec "mixed after second run" "$MIXED_SVC" "$TARGET_NODE" "$TARGET_VERSION"
  assert_state_exec "stopped after second run" "$STOPPED_SVC" "$TARGET_NODE" "$TARGET_VERSION"
  assert_preserved_state_metadata "stable after second run" "$STABLE_SVC" stable.js 1
  assert_preserved_state_metadata "stopped after second run" "$STOPPED_SVC" stable.js 1
  assert_preserved_state_metadata "mixed after second run" "$MIXED_SVC" stable.js 2

  assert_preserved_unit_directives "stable after second run" "$STABLE_SVC" 1
  assert_preserved_unit_directives "stopped after second run" "$STOPPED_SVC" 1
  assert_preserved_unit_directives "mixed after second run" "$MIXED_SVC" 2

  assert_file_stat_preserved "stable unit ownership/mode after second run" "$(unit_path_for "$STABLE_SVC" 1)" "$stable_unit_stat_before"
  assert_file_stat_preserved "stable environment ownership/mode after second run" "$(env_path_for "$STABLE_SVC")" "$stable_env_stat_before"
  assert_file_stat_preserved "stopped unit ownership/mode after second run" "$(unit_path_for "$STOPPED_SVC" 1)" "$stopped_unit_stat_before"
  assert_file_stat_preserved "stopped environment ownership/mode after second run" "$(env_path_for "$STOPPED_SVC")" "$stopped_env_stat_before"
  assert_file_stat_preserved "mixed unit ownership/mode after second run" "$(unit_path_for "$MIXED_SVC" 2)" "$mixed_unit_stat_before"
  assert_file_stat_preserved "mixed environment ownership/mode after second run" "$(env_path_for "$MIXED_SVC")" "$mixed_env_stat_before"

  assert_env_path_prefixed "stable after second run" "$(env_path_for "$STABLE_SVC")" "$TARGET_BIN"
  assert_env_path_prefixed "mixed after second run" "$(env_path_for "$MIXED_SVC")" "$TARGET_BIN"
  assert_env_path_prefixed "stopped after second run" "$(env_path_for "$STOPPED_SVC")" "$TARGET_BIN"

  assert_enabled_state "stable after second run" "$STABLE_SVC" 1
  assert_enabled_state "mixed instance 0 after second run" "$MIXED_SVC@0" 1
  assert_enabled_state "mixed instance 1 after second run" "$MIXED_SVC@1" 1
  assert_enabled_state "stopped after second run" "$STOPPED_SVC" 0

  [[ "$(unit_pid "$STABLE_SVC")" == "$pid_stable_after_first" ]] \
    || fail "stable MainPID changed on the idempotent second run"
  [[ "$(unit_pid "$MIXED_SVC@0")" == "$pid_mixed0_after_first" ]] \
    || fail "mixed instance 0 MainPID changed on the idempotent second run"
  [[ "$(unit_nrestarts "$STABLE_SVC")" == "$nrestarts_stable_after_first" ]] \
    || fail "stable NRestarts changed on the idempotent second run"
  [[ "$(unit_nrestarts "$MIXED_SVC@0")" == "$nrestarts_mixed0_after_first" ]] \
    || fail "mixed instance 0 NRestarts changed on the idempotent second run"

  assert_runtime "old runtime after second run" "$OLD_NODE" "$OLD_VERSION"
  assert_runtime "target runtime after second run" "$TARGET_NODE" "$TARGET_VERSION"

  alias_after_second="$(alias_signature)"
  assert_value_equal "nvm default alias after second run" "$ALIAS_BEFORE" "$alias_after_second"

  verify_unit "$STABLE_SVC.service"
  verify_unit "$STOPPED_SVC.service"
  verify_unit "$MIXED_SVC@0.service"
  verify_unit "$MIXED_SVC@1.service"

  info "All assertions passed; removing test resources"
  remove_created_resources
  assert_no_test_resources_left

  trap - EXIT INT TERM HUP ERR
  ok "update-node integration test passed"
  exit 0
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
enable_err_trap

main "$@"
