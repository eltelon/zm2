# Single-instance-only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Accept instance-count inputs for compatibility while creating one service and rejecting activation of legacy templates.

**Architecture:** Shared `lib/Systemd/InstancePolicy.js` normalizes new configuration and rejects legacy entries by count, unit identity or existing template file. Apply before mutations in lifecycle, startup, migration and runtime selection. Keep template stop/delete/parser support.

**Tech Stack:** Node >=16, Mocha, Bash, systemd/Compose on dedicated Colima.

**Specification:** `docs/superpowers/specs/2026-11-04-single-instance-only-design.md`.

## Shared policy contract

`normalize(conf, warn)` mutates only `conf.instances` to 1; warns on explicit non-one scalar requests (including 0/max), no warning for missing/1/'1'; never edits conf.env. `assertSingle(entry, options)` throws a stable descriptive error with code `ZM2_MULTI_INSTANCE_DISABLED` for `instances > 1`, `serviceName` containing systemd @ identity, or existing base template file. `options` provides `fs` and `unitDir` for injected runtime adapters; defaults native fs and `/etc/systemd/system`. No mutations. Error directs explicit stop/delete/recreate, warning downtime. Invalid counts remain validated by the config schema where applicable; valid legacy metadata must not be rewritten.

## Task 1: Policy, normalization, lifecycle and migration

Files: `lib/Systemd/InstancePolicy.js` (new), `lib/Common.js`, `lib/API.js`, `lib/SystemdClient.js`, `lib/API/Migrate.js`; tests `test/programmatic/systemd_instance_policy.mocha.js` (new), `systemd_single_instance.mocha.js` (new), relevant lifecycle/migration expectations.

- [x] Write failing policy and adapter tests: accepted count forms become one with warning, env.INSTANCES untouched; legacy count/alias/template rejected without env/files/state/systemctl mutation; single lifecycle still works.
- [x] Normalize at verifyConfs and after ecosystem CLI override, plus prepare boundary. Create one non-template unit only. Reject prepare collision with existing legacy metadata or template before env writes.
- [x] Guard start/restart/reload before environment updates. Keep stop/delete loops and errors intact. Preserve ID/name resolution behavior without allowing template aliases to escape the guard.
- [x] Inspect migration direct template-generation bypass; normalize converted config and reject existing-template collisions before installation or stop of source PM2 apps. Retain default single-service behavior.
- [x] Update old lifecycle expectations for activation, retaining multiinstance stop/delete and unit parser tests. Run targeted tests without retries.

## Task 2: Startup and runtime-update guards

Files: `lib/API/Startup.js`, `lib/Systemd/NodeRuntimeUpdater.js`; tests `test/programmatic/systemd_single_instance_operations.mocha.js` (new), relevant `systemd_node_update.mocha.js` and `update_node_cli.mocha.js` cases.

- [x] Write failing tests for startup rejecting legacy while optionally continuing eligible singles and returning error; unstartup still disables all legacy units.
- [x] Add shared assertSingle before startup enables. Return aggregate failure if any entry rejected/enable failed, never silently succeed.
- [x] Write failing runtime selection tests: legacy count/template alias/orphan template rejected as failed_unchanged before snapshots/runtime preparation; only legacy means no nvm.prepare; mixed eligible singles still update and overall exit1. Cover rollback false identically.
- [x] Guard runtime selection with injected fs/unitDir; preserve lower-level legacy parser/runtime-config coverage but replace updater tests that promise multiinstance activation with no-side-effect rejection tests.
- [x] Run targeted operations/update tests without retries and review code changes. Do not touch Task1 files or tests.

## Task 3: Integration, documentation and final review

Files: `test/e2e/systemd/update-node.sh`, `test/e2e/systemd/compose-scenarios.sh`, `test/systemd/README.md`, `README.md`, `CLAUDE.md`, `lib/binaries/CLI.js`, `lib/API/schema.json`, `types/index.d.ts`, sample HTTP template/docs.

- [x] Replace legacy update-node e2e multiinstance creation with explicit legacy fixtures + rejection expectations (or isolate those checks in the Compose scenario), preserving single-service update/rollback/idempotency and cleanup coverage.
- [x] Exercise Express CLI -i4, --instances and ecosystem env-derived count: one non-template unit with healthy HTTP, metadata1, warning, no extra unit/PID. Create legacy template/state explicitly for start/restart/reload/startup/update-node rejections; verify no mutations and continued stop/delete.
- [x] Update help/schema/types/docs/templates to say instance option is accepted but ignored; document no automatic disable of legacy services at upgrade and explicit downtime migration. Do not change historical specs or root lockfiles.
- [x] Run baseline selective suites plus new tests without retries. Report the known excluded legacy runner/interpreter expectations separately.
- [x] Install fixture-local dependencies, start only `zm2-systemd-test` with activate=false, execute the full real Linux harness, retain evidence and clean containers. Stage new source files before filtered builds.
- [x] Independent spec review and code-quality review, fix confirmed issues with regression tests, simplify changed code, repeat final targeted tests and full integration. Record results, commit locally, no push/merge/npm publication.

## Review corrections and evidence (2026-11-04)

- Independent spec review found raw `StateStore.get()` metadata lacked `serviceName`; prepare/migration now attach the known unit identity. Real-store regressions cover template collisions with count-one metadata, including forced migration.
- Discovery previously assigned every unregistered unit ID zero, risking operations on the API service. Discovered units now retain canonical string IDs; exact template-aware resolution replaces arbitrary index lookup. Public start/restart/reload/stop/delete round-trip those IDs, including numeric-prefix alias safety. Tests first reproduced the failures, then passed.
- HTTP API installation/restart now guards legacy `zm2-api` collisions before key/unit/state changes. Resurrection continues eligible applications but aggregates failures instead of claiming complete success.
- Quality review corrected missing reload stubs and made the legacy-only updater home a fresh private `mktemp` directory. Both reviewers cleared their remaining findings after targeted re-review.
- Simplification: shared explicit policy imports, removed unreachable migration count formatting and prepare count variable; kept legacy parsing and stop/delete paths.
- Final selected host suites: **488 passing**, `--retries 0`, `/tmp/zm2-single-unit-final.log`. Reproduce from this worktree using:

```bash
../../node_modules/.bin/mocha --retries 0 test/programmatic/{systemd_lifecycle,systemd_safety,systemd_state_store,http_api,systemd_logs,nvm,systemd_node_update,systemd_runtime_config,systemd_runtime_verifier,update_node_cli,systemd_harness,systemd_build_context,systemd_express_fixture,systemd_instance_policy,systemd_single_instance,systemd_single_instance_operations,systemd_single_instance_resolution,systemd_single_instance_api}.mocha.js
```

- Final full real-systemd harness: **exit 0**, `/tmp/zm2-systemd-results/zm2-systemd-e2e.eT0Na5`. Linux ARM64, systemd 255, cgroups v2, Node 22.14.0 → 24.0.0, nvm 0.40.3, Express 5.1.0. Includes canonical and short instance-alias rejections, unchanged legacy state/PIDs/enablement, legacy cleanup, existing single lifecycle, init/container restart, rollback and no-rollback scenarios. Container/init restart is not a kernel/VM reboot.
- Earlier full passes: `d2zaNH`, `a3mXND`, `BJ2FtZ` under the same evidence root. Failed integration attempts were retained: `CPIy0X` exposed an ecosystem fixture filename missing `.config.js`; `VIPXHz` exposed the physical-template lookup missing from canonical alias resolution. Both were corrected, not skipped.
- Separate inherited suites still report **27 passing / 8 known failures** for bare-versus-absolute interpreter paths: `/tmp/zm2-single-known-legacy.log`. No claim that legacy `npm test` passes; that runner was not executed.
- `bash -n` and `git diff --check` pass. Root lockfiles, main checkout and the unrelated `update-node` worktree are untouched. Harness containers are removed; only the dedicated Colima profile was used with `--activate=false`.
