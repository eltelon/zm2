# Service Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Apply the five approved review corrections: boot persistence, malformed HTTP requests, private environment files, visible systemd failures, and transactional state mutations.

**Architecture:** Route start operations through the existing enable/start command, leaving explicit restart independent. Validate malformed routes at the HTTP boundary. Preserve synchronous interfaces while making filesystem operations private and state mutations serialized and atomic. Do not implement naming/ID redesign, argument escaping, or legacy CI migration.

**Tech Stack:** Node.js >=16, filesystem APIs, systemd adapter, Mocha with stubbed systemd and temporary directories.

## Tasks

- [x] 1. Start persistence (`lib/API.js`, `lib/SystemdClient.js`, new `test/programmatic/systemd_lifecycle.mocha.js`): first reproduce existing-app start dispatch and enable failures. Cover name, ID, namespace, all, path and ecosystem routes. Start must enable before activation; preserve the public CLI/API.start behavior of restarting existing apps (including updated env), while direct startProcessId calls keep enable + start. Explicit restart must not change enabled state. Preserve environment updates and process-shaped results. Run regression tests red, implement, then green.
- [x] 2. HTTP parsing (`lib/API/HttpApi.js`, `test/programmatic/http_api.mocha.js`): reproduce malformed percent-encoded action names, return JSON 400 instead of uncaught URIError, verify subsequent authenticated/unauthenticated requests still work. Run tests red/green.
- [x] 3. Environment permissions (`lib/Systemd.js`, new `test/programmatic/systemd_safety.mocha.js`): create env directory with 0700 and files with 0600; restrict existing targets before replacing contents. Test real permissions in an isolated temp filesystem adapter, including preexisting 0644 files, no root/systemd calls.
- [x] 4. Lifecycle error propagation (`lib/Systemd.js`, `lib/SystemdClient.js`, `lib/API.js`, lifecycle/safety tests): fail enable/start/stop/disable explicitly; do not unlink any configuration or unregister if stopping/disabling a unit or timer fails. Multiinstance operations must not report complete success after partial failure. Preserve original errors through the public API. Test failures before implementation.
- [x] 5. Transactional state (`lib/Systemd/StateStore.js`, `test/programmatic/systemd_state_store.mocha.js`): serialize reload/mutate/save across processes with an exclusive lock and bounded wait; atomically replace state using a same-directory temporary file. Register/unregister/clear use transactions, readers refresh from committed state, failed writes preserve the old state. Test stale clients, concurrent child processes, lock failure and write/rename failure. No silent takeover of a live lock or overwriting unreadable/corrupt state during a mutation.
- [x] 6. Review and verify: inspect all diffs, review specification compliance and code quality, run targeted suites without retries; separately report the eight preexisting interpreter-path expectation failures. Do not run destructive systemd calls or the legacy global reset runner. No commits required for these changes.

## Verification

- Regression tests were run before implementation and reproduced the reviewed failures.
- Targeted command: `./node_modules/.bin/mocha --retries 0 test/programmatic/systemd_lifecycle.mocha.js test/programmatic/systemd_safety.mocha.js test/programmatic/systemd_state_store.mocha.js test/programmatic/http_api.mocha.js test/programmatic/systemd_logs.mocha.js` — 165 passing.
- Adding `systemd_unit_generator.mocha.js` and `systemd_migrate.mocha.js` with `--no-bail --retries 0` — 192 passing, the same 8 preexisting interpreter-path expectation failures observed before changes.
- Environment: Node 22 on macOS. Real systemd integration still requires Linux; systemd commands were stubbed, filesystem tests used temporary directories, concurrency tests used six real child processes.
- Review follow-ups covered new/existing ecosystem failures, stop/delete from ecosystem files, public kill and CLI exit codes, empty kill idempotency, and explicitly pinned ID collisions.
- Orphaned lock files are not automatically stolen. README documents the bounded wait and manual recovery after verifying no active writer.

## Integration with remote update-node

- Merged the remote `update-node` / `--no-rollback` work without dropping the safety fixes.
- `StateStore.replace()` reloads under the shared mutation lock and atomically persists an exact metadata snapshot, retaining unrelated concurrent registrations and refusing deleted services or duplicate IDs.
- Strict loads retain the remote validation/error contract. Atomic writes preserve existing state ownership/mode; newly created state remains `0600`.
- Kept both test sets and added three regressions for replacement with stale clients, concurrent deletion and ID collisions. Updated the temporary-file assertion to account for the exclusive lock as well as the exclusive data file.
- Combined safety and update-node verification: **410 passing**, no retries, across the five safety suites and `nvm`, `systemd_node_update`, `systemd_runtime_config`, `systemd_runtime_verifier`, `update_node_cli`.
- JavaScript syntax and both bash runners checked. Linux/systemd integration remains unexecuted on this macOS host.
