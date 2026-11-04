# Real Linux/systemd integration sandbox

This opt-in harness builds the **local source**, not the npm release. Express runs as a ZM2-managed systemd service inside one Linux container; it is not a separate Node container. The administrative ZM2 HTTP API is not installed.

## Safety and requirements

- macOS with Colima/VZ, Docker CLI and Compose (tested on Apple Silicon).
- Internet for Ubuntu packages, SHA-checked nvm 0.40.3, official checksum-checked Node 22.14.0/24.0.0, npm dependencies and Express 5.1.0. These old pinned runtimes are test fixtures, not production upgrade recommendations.
- A **dedicated disposable** profile named `zm2-systemd-test`, not `default`. A privileged container can compromise its entire Linux VM. Never point this harness at shared/production Docker.
- No host filesystem, Docker socket, systemd bus or host cgroup bind mounts; private cgroup namespace. No published ports; health checks use loopback inside the container.
- At least 2 CPU, 4 GiB RAM and 20 GiB disk. The VM remains running after tests; delete it separately when finished.

Create the dedicated profile without host directory mounts, SSH agent forwarding or context switching:

```bash
colima start zm2-systemd-test --activate=false --runtime docker \
  --vm-type vz --arch aarch64 --cpus 2 --memory 4 --disk 20 \
  --mount none --ssh-agent=false --ssh-config=false --template=false
```

The runner validates both the context name and its expected Unix socket at `$HOME/.colima/zm2-systemd-test/docker.sock`, rejects `DOCKER_HOST` and conflicting `DOCKER_CONTEXT`, and requires Linux/cgroups v2 before creating resources. Run only with an operator-controlled Docker configuration and a fresh profile created as above. Do not remap this context to another daemon. The VM checks do not establish container-systemd health; the `backend` phase does that.

## Execute

From the repository/worktree root:

```bash
ZM2_SYSTEMD_E2E=1 bash test/systemd/run.sh --preflight
ZM2_SYSTEMD_E2E=1 bash test/systemd/run.sh
```

The runner never changes the active Docker context. Each run gets a fresh project name and results directory, displayed on stdout. Set `ZM2_SYSTEMD_RESULTS=/absolute/parent` to select its parent. Image/build caches remain only on the disposable daemon. The runner first materializes a filtered build context: tracked production source (including local edits) and explicitly named fixture/scenario inputs. Stage new production files before testing them. Local `.env`/`.npmrc`, dependency directories and `.git` are not copied. Both builders receive a root `.dockerignore` in this filtered context, so a missing-buildx fallback does not send the checkout to Docker. Direct Compose builds require the runner-generated `ZM2_SYSTEMD_BUILD_CONTEXT`.

On success or failure, diagnostics are collected before the project is removed. Set `ZM2_SYSTEMD_KEEP=1` to retain **failed** projects for diagnosis; the runner prints their exact cleanup command. Interruptions normally invoke cleanup, but SIGKILL/host loss requires using the saved project identity in `run.txt`.

## Scenarios

1. PID 1, systemctl, actual unit cgroups and journal. Failed background units must be diagnosed rather than treated as successful systemd startup.
2. Single-instance compatibility (`-i`, `--instances`, environment-derived ecosystem counts) and explicit legacy-template activation rejection/cleanup; ZM2 start/stop/start/restart; enabled-state preservation; HTTP PID/runtime matched against MainPID and procfs; journal and finite CLI logs; private env permissions including restrictive rewrites; concurrent registration; visible control failure and safe deletion.
3. Stop and start the **same container** with persistent units, metadata and filesystem, but fresh `/run` and `/tmp`. An enabled Express app must start automatically, while a stopped/disabled app remains stopped. Init identity/configuration fingerprints are compared.
4. Existing `test/e2e/systemd/update-node.sh`: stable update, incompatible rollback, stopped single-service app, idempotency, ownership/mode preservation and cleanup.
5. `--no-rollback`: failed startup must return 1 without restoring the old configuration, while compatible apps update and stopped apps stay stopped. HTTP checks independently confirm Express on the new runtime.

No global `zm2 kill`, `delete all`, host reboot, shared state home or mock systemd is used. Test services have the prefix `zm2-compose-e2e-`; the existing update script uses its own guarded prefix and isolated home.

## Evidence and reproducibility limits

Results include scenario logs/status, resolved Compose configuration, source commit/dirty state and patch, harness sources, versions, image/container identity and mounts, systemctl/journal output, boot comparison data, and dependency lockfiles. There are no environment/secret dumps. Inspect `exit-code.txt`: only zero means the whole run, including cleanup, passed.

The inherited root lockfile still describes PM2 dependencies. It is preserved in evidence but **not used to claim a reproducible current dependency install**. The image derives a lockfile from the current manifest, installs with `npm ci --omit=dev --ignore-scripts`, and retains that generated lock for the run. Express has its own committed lockfile. Root `package.json`, `package-lock.json` and `bun.lock` are not changed. Base Ubuntu/apt packages and dependencies allowed by root semver ranges may change on a future clean build; the recorded image ID, build log and installed lock identify the actual tested artifact. This is repeatable validation, not a bit-for-bit reproducible image build.

A container-init restart tests systemd startup with preserved files. It **does not prove Linux kernel reboot, VM reboot or host boot**. Kernel boot ID may stay unchanged; the script compares systemd's userspace/init identity instead. Runtime verification is not a long-term health guarantee.

Host-only guard and fixture checks (do not test Linux integration):

```bash
npm --prefix test/fixtures/systemd-express ci --ignore-scripts --no-audit --no-fund
./node_modules/.bin/mocha --retries 0 \
  test/programmatic/systemd_harness.mocha.js \
  test/programmatic/systemd_build_context.mocha.js \
  test/programmatic/systemd_express_fixture.mocha.js
```

The fixture uses Express 5 and requires Node >=18; the sandbox uses Node 22/24. This does not change ZM2's Node >=16 production contract. The fixture packages are not added to ZM2 dependencies. Use the repository's existing installed Mocha; do not run `npm ci` at the root assuming the inherited lock is current.

## Recorded validation

On 2026-11-03, the complete harness passed on the dedicated ARM64 Colima VM with systemd 255, kernel 6.8, Node 22.14.0 -> 24.0.0, nvm 0.40.3 and Express 5.1.0. Lifecycle, safe deletion, concurrent registrations, same-container init restart, rollback and `--no-rollback` all passed against real systemd/journald. The combined targeted unit/host/fixture selection passed 427 tests without retries; the legacy `npm test` runner was not run.

Implementation evidence and limitations are recorded in `docs/superpowers/plans/2026-11-03-systemd-compose-validation.md`. Host `/tmp` logs are temporary; rerun the harness to produce fresh evidence. No production source or root dependency lockfile was changed.

## Cleanup

The runner removes only its uniquely named Compose project, containers, network and any project volumes. It does not prune images or touch `default`. For retained runs, use the exact printed command, for example:

```bash
docker --context colima-zm2-systemd-test compose \
  -f <results-directory>/compose.yaml -p <project-from-run.txt> down --volumes
```

After all diagnostics have been copied and no test is running, remove only the disposable VM (also removes its image caches):

```bash
colima stop zm2-systemd-test
colima delete zm2-systemd-test
```

Keep the host results directory until it is no longer needed. No automatic npm publication, tagging, push or CI migration is performed.
