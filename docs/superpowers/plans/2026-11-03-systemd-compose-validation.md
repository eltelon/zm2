# Real systemd Compose Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and execute isolated Linux/systemd integration coverage for ZM2, Express lifecycle, container-init persistence and Node runtime updates.

**Architecture:** A privileged systemd container runs only on the dedicated Colima Docker endpoint, with a private cgroup namespace and no host bind mounts or published ports. Host orchestration collects evidence and restarts the same container; internal scripts assert real CLI/systemd/HTTP behavior.

**Tech Stack:** Bash, Docker Compose, Ubuntu 24.04, Node 22.14.0 and 24.0.0, nvm 0.40.3, Express, Mocha.

**Approved specification:** `docs/superpowers/specs/2026-11-03-systemd-compose-validation-design.md`.

## File boundaries and shared contracts

- `test/fixtures/systemd-express/{package.json,package-lock.json,server.js}`: standalone app only; `test/programmatic/systemd_express_fixture.mocha.js`: fixture behavior tests.
- `test/systemd/{Dockerfile,Dockerfile.dockerignore,compose.yaml,build-context.sh,run.sh,README.md}`: image, isolation, host orchestration and operating instructions.
- `test/e2e/systemd/compose-scenarios.sh`: internal phases `backend`, `lifecycle`, `prepare-boot`, `verify-boot`, `no-rollback`, `cleanup`; can invoke itself across phases. Existing `update-node.sh` stays intact.
- `test/programmatic/systemd_harness.mocha.js`: host guard/structural checks, without destructive commands. `test/programmatic/systemd_build_context.mocha.js`: effective context allowlist/canary test.

Fixture contract: `HOST` defaults to `127.0.0.1`, `PORT` defaults to `3000`, `FAIL_ON_NODE_VERSION` optionally exits nonzero on the exact requested `process.version` (optional v prefix). `/health` returns `{status: 'ok', pid, node: process.version}`; stdout contains `ZM2_EXPRESS_READY`. Fixture path in image is `/opt/zm2/test/fixtures/systemd-express/server.js`.

Image contract: `NVM_DIR=/opt/nvm`, `ZM2_NODE_OLD=22.14.0`, `ZM2_NODE_TARGET=24.0.0`, fixed CLI `/opt/nvm/versions/node/v22.14.0/bin/node`, source `/opt/zm2`, `ZM2_HOME=/var/lib/zm2-test`, evidence `/var/lib/zm2-evidence`; old runtime on PATH. Systemd PID 1, tmpfs `/run` and `/tmp`, private cgroups, no binds or ports. Source fixture dependencies installed separately. Internal scripts use absolute CLI Node to avoid runtime drift.

Runner contract: `bash test/systemd/run.sh` performs an opt-in run only when `ZM2_SYSTEMD_E2E=1`, uses explicit context `colima-zm2-systemd-test` and validates its expected local socket before daemon operations. `--preflight` checks guards without creating resources. Results path under an operator-selected `ZM2_SYSTEMD_RESULTS` or a fresh host temporary directory. `ZM2_SYSTEMD_KEEP=1` retains failed resources; otherwise collect diagnostics then clean the uniquely identified Compose project only. Never change active context or stop/delete Colima automatically.

## Task 1: Fixture and its regression tests

- [x] Write fixture tests first: defaults/health PID and runtime, startup journal marker, optional exact-version failure, and unrelated runtime remaining healthy. Run red before writing the fixture.
- [x] Implement the standalone Express package with an exact version and own lockfile, without changing root dependencies. Use temporary free ports in tests and terminate child processes after assertions.
- [x] Run `../../node_modules/.bin/mocha --retries 0 test/programmatic/systemd_express_fixture.mocha.js` from the worktree; inspect actual changes and simplify.

## Task 2: Real-systemd internal scenarios

- [x] Write phase scripts as integration assertions against real systemctl, procfs, CLI, journal and HTTP. Reuse the existing runtime-update script rather than duplicating it. Refuse non-Linux/nonroot/non-systemd environments and require `ZM2_SYSTEMD_E2E=1`.
- [x] Cover lifecycle start/stop/start and restart preserving enabled/disabled state; enforce env modes, journal/CLI logs, concurrent StateStore registrations, and safe delete failure using a temporary RefuseManualStop drop-in on a test service.
- [x] Prepare active-enabled and stopped-disabled Express units, capture config/state fingerprints and an init identity that changes across container restart (for example systemd userspace timestamp). After restart, assert automatic recovery without start calls and preserved files/stopped state.
- [x] Assert no-rollback failure keeps target ExecStart/PATH/metadata, returns 1, continues to a compatible app, leaves a stopped app inactive, and confirms HTTP runtime on the compatible Express app. Remove only owned, named units; never all.
- [x] Validate shell syntax and run each phase inside the sandbox when Task 3 provides it. A failed assertion must remain nonzero, with journal diagnostics retained.

## Task 3: Image, runner, integration and evidence

- [x] Run baseline targeted safety/update-node tests without retries and record the result separately from Linux integration. Do not execute the legacy destructive global runner.
- [x] Add red tests for runner opt-in/context/socket guards using fake Docker only at the host safety boundary; assert no mutation before validation. Add structural assertions for no mounts/ports and image build allowlist.
- [x] Implement Compose/image with systemd, SHA-verified pinned nvm/Node downloads and separate fixture install. Inspect inherited root lock mismatch; derive installation lock inside image if required, preserve it in evidence, and never rewrite root locks.
- [x] Materialize a filtered context from tracked production files plus exact fixture/script filenames. Give both classic and BuildKit a root ignore file; reject local credentials/dependencies with an effective canary test. Recover stopped/partially created container IDs when collecting early startup failures.
- [x] Implement preflight, unique project, build/up, bounded readiness, phases, full stop/start of the same container, legacy update-node invocation, no-rollback, results capture and cleanup trap preserving original status.
- [x] Run host tests green and shell/JavaScript/Compose syntax checks. Probe actual PID 1 and private writable cgroups. Stop for design review if this needs host cgroup mounts or expanded access.
- [x] Execute the full runner, retain evidence including image identity/versions, init identity, HTTP, journal, configuration, lockfiles and all scenario exits. Diagnose failures systematically rather than relaxing production contracts.
- [x] Write exact usage, prerequisites, retention, cleanup and reboot limitations in `test/systemd/README.md`; add a short root README link.
- [x] Review specification coverage and code quality with a reviewer, address confirmed findings, rerun affected tests plus the complete integration harness, and mark completed tasks with concrete evidence paths/results. Keep changes on the isolated branch; no push/npm publication.

## Evidence collected during implementation

- Baseline: 410 targeted safety/update-node tests passing without retries, `/tmp/zm2-compose-baseline.log`.
- Initial fixture + host guards: 15 passing, `/tmp/zm2-compose-host-tests.log` (not Linux integration).
- Real image probe: systemd PID 1, state running, zero failed units, writable private cgroups, no Docker mounts/ports, transient unit succeeded and appeared in journald.
- First real update-node attempt rejected nvm archive mode 0775. Image now strips group/world write permissions from nvm; did not relax its trusted-script guard.
- Existing real `update-node.sh` completed successfully with Node 22.14.0 -> 24.0.0 after that harness correction; evidence `/tmp/zm2-systemd-results/early-probe/early-update-node.log` and `.exit` (0). Two earlier interactive calls timed out; their partial output is not treated as passing evidence.
- Independent review found legacy Docker ignores the Dockerfile-specific ignore. Synthetic classic-builder canary reproduced this; replaced checkout builds with a prefiltered staging context and root ignore. Fixture inclusions are now exact filenames. Canary copy test and partial-startup diagnostic regression both passed (red/green).
- Full suite: **427 passing**, no retries, `/tmp/zm2-compose-final-unit.log` (410 existing targeted tests plus 17 new host/fixture checks). This is not the legacy `npm test`; the known eight interpreter-expectation failures remain out of scope.
- Four complete real Linux runs passed: `xtqgbZ`, `89NZmz`, `TzKI8O` and most recently `/tmp/zm2-systemd-results/zm2-systemd-e2e.kSqJsf` (all under `/tmp/zm2-systemd-results`, exit 0). Final run includes successful owned failed-tombstone reset and confirms no loaded test services remain before container teardown. Empty systemd-created template slices can live until the sandbox is removed.
- Final tested environment: systemd 255.4-1ubuntu8.18, kernel 6.8.0-117-generic aarch64, Node 22.14.0/24.0.0, nvm 0.40.3, Express 5.1.0. Docker inspection confirms privileged=true, private cgroups, mounts=[], ports={}. All scenario exit codes are saved separately.
- Same-container userspace timestamps and procfs PID1 starttime changed; kernel boot ID and unit/env/state hashes persisted. Health JSON confirms old and target Node runtimes. This validates container systemd startup, not Linux/VM/host reboot.
- No production files or root dependency locks changed; the active Docker context stayed `colima`, `default` stayed stopped, and test containers/networks were removed. Profile `zm2-systemd-test` remains running for repeatable use; profile removal is documented and not automatic.
- Final independent review closed both P2 findings: safe-delete now requires CLI exit 1 rather than accepting timeouts; aliased phases preserve separate backend and cleanup evidence. Reviewer confirmed both fixes; the final 427-test selection and entire real integration harness passed afterward. Before/after backend and both cleanup directories were individually verified, as were all ten zero-valued scenario/overall exit-code files.
- No remaining review blockers. JavaScript/shell syntax and git whitespace checks passed. Implementation stays in `test/systemd-compose-validation` worktree branch with no push/npm publication.
