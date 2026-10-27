# Development

## Setup

Requires [Bun](https://bun.sh) 1.4 (CI uses 1.4.4), Node.js 20+ and git.

```sh
bun install
bun src/cli.ts --help        # run from source
bun src/cli.ts doctor
```

## Checks

```sh
bun check                    # type check
bun run lint                 # oxlint
bun run fmt                  # oxfmt (CI runs it with --check)
bun test                     # all tests use fake agents; no tokens are spent
bun run build                # standalone binary for this machine in dist/<os>-<arch>/
```

The tests cover:

- **Points rules:** only the agent that raised a point can close it, and each agent answers only the other's points. Disputes, needs-user decisions, failed checks, unsettled low-severity points, and malformed or uninspected output never yield success.
- **The discussion:** the author raises and withdraws its own points, a full review in fresh sessions follows each settled discussion, and a run completes only after a clean full review.
- **Stopping:** round limits, timeouts, stalls and cancellation stop correctly.
- **Stable IDs:** IDs stay stable, and restatements merge across rounds.
- **Durability:** partial results and transcripts survive failures and interruption.
- **Tool policy:** paths, git history and blob access, external diff helpers, and verification commands.
- **Processes:** process-group cancellation, including descendants that ignore SIGTERM.
- **Run files:** working-tree snapshots, ordered artifact writes, CLI validation, and `doctor`.
- **Models and setup:** catalog parsing and the runtime protocols (against fake runtimes), typo suggestions, effort checks, Codex defaults, plan and check detection, and that the printed command line parses back to the same configuration.

## Real-provider smoke test

This uses both providers and spends tokens. A small fixture repository with a deliberately flawed plan works well.

```sh
crosscheck plan PLAN.md --repo . --rounds 2 \
  --author claude-code:claude-sonnet-5-5 --reviewer codex:gpt-6-luna \
  --effort medium --check "bun test" --verbose
```

Verified with real providers (Claude Code subscription and Codex ChatGPT login, on a small Bun + SQLite fixture). Most of this list predates the 0.3.0 discussion loop. That loop was checked with Sonnet as author and gpt-6-luna as reviewer, both at medium effort, capped at 6 rounds: the author raised its own point and the reviewer accepted it, fresh full reviews in rounds 1, 5 and 6 each found new issues, and the run ended `budget_exhausted` with one low-severity point still under discussion.

- **Plan mode.** The reviewer found the planted flaws: Postgres and Redis against a single-instance SQLite constraint, no 429 path out of `authenticate()`, manual-only testing. The author revised, the reviewer verified, and the run ended `review_complete`.
- **Disputes and escalation.**
  - In one run the author disputed a finding and the reviewer tried to "verify" it. Validation rejected that, and the correction turn withdrew it instead.
  - Another run ended `needs_input` after the reviewer escalated a product question.
- **Brief mode with swapped roles** (Codex as author, Claude Code as reviewer).
- **Verification commands:** a run with `--check "bun test"` executed the check and ended `review_complete`.
- **Cancellation:**
  - Ctrl-C mid-review exited 130, terminated the bridge processes, recorded `cancelled`, and kept plan v0.
  - An interruption during startup behaved the same way.
- **Interactive prompts**, driven through a pseudo-terminal: the full guided setup, and picking the suggested model after a typo in flag mode.
- **Standalone binary, fresh install.** The compiled binary ran a full review with an empty `HOME`, so it downloaded and installed both agent runtimes through the embedded `pnpm` shim.
- **Untested:** API-key (non-subscription) authentication, and a real run reaching the time limit.

## Releasing

1. Update `version` in `package.json` and add a matching `## [x.y.z]` section to `CHANGELOG.md`.
2. Commit, then tag and push:

   ```sh
   git tag v0.2.0 && git push origin main v0.2.0
   ```

3. The [release workflow](../.github/workflows/release.yml) then runs:
   - checks that the tag matches `package.json` and that the changelog has an entry;
   - runs the checks and tests;
   - builds `linux-x64` and `linux-arm64` on Linux runners, and `darwin-arm64` and `darwin-x64` on macOS runners (ad-hoc signed);
   - smoke-tests each binary with `--version` and `doctor --json` (the embedded bridge files must load);
   - publishes the archives, `checksums.txt` and release notes taken from the changelog.

   Archives are named `crosscheck-<version>-<os>-<arch>.tar.gz`.
4. The [Homebrew tap](https://github.com/brielov/homebrew-tap) regenerates `Formula/crosscheck.rb` from the latest release within the hour. To update it right away:

   ```sh
   gh workflow run update.yml -R brielov/homebrew-tap
   ```

## Upgrading the agent adapters

The harness packages are experimental, so they are pinned to exact versions. Dependabot only updates GitHub Actions.

| Package | Pinned |
|---|---|
| `@ai-sdk/harness` | 1.0.158 |
| `@ai-sdk/harness-claude-code` | 1.0.162 |
| `@ai-sdk/harness-codex` | 1.0.160 |
| `ai` | 7.0.147 |

The releases after these (`harness-claude-code` ≥ 1.0.163, `harness-codex` ≥ 1.0.161) were published without `dist/bridge/pnpm-lock.yaml`, which their own bootstrap reads, so session creation fails with `ENOENT`. Before upgrading:

1. Check that the new adapter tarballs ship their complete `dist/bridge/` directory.
2. Run `bun spike/harness-spike.ts claude <repo>` and `bun spike/harness-spike.ts codex <repo>`.
3. Re-check what the Codex adapter forces (`sandbox_mode`, `approval_policy`) and which tools it filters.
4. Build a binary and run a real smoke test with it. `scripts/build.ts` fails if the adapters' bridge-file references change shape.
