# crosscheck

Automates a Claude → Codex → Claude plan review loop. One agent (the **author**) writes or revises a technical plan; another (the **reviewer**) independently checks it against your actual repository. crosscheck runs the outer loop, keeps a findings ledger with stable IDs, and stops with an explicit outcome and a report.

Both agents run locally as real coding agents (Claude Code and Codex) through the Vercel AI SDK's `HarnessAgent`, with read-only access to the repository.

## Requirements

| | Tested with | Notes |
|---|---|---|
| Bun | 1.4.4 (`>=1.3` expected to work) | runs the CLI |
| Node.js | 24.x | the harness bridge processes run with `node` |
| git | 2.56 | repository identity and search; non-git directories work with reduced features |
| Claude Code access | Claude subscription login or `ANTHROPIC_API_KEY` | for the `claude-code` provider |
| Codex access | ChatGPT login or `OPENAI_API_KEY` | for the `codex` provider |

On the first run each adapter installs its pinned runtime (Claude Code / Codex CLI plus a small bridge) into `~/.ai-sdk-harness/`. This needs network access and takes a minute. If `pnpm` is not installed, crosscheck provides it through `bun x pnpm@10.34.9`.

## Install

```sh
bun install
bun link            # puts `crosscheck` on your PATH (or run `bun src/cli.ts ...`)
```

## Authentication

crosscheck uses the credentials of the CLIs you already have:

```sh
claude              # then /login  (or: export ANTHROPIC_API_KEY=...)
codex login         # ChatGPT plan  (or: export OPENAI_API_KEY=...)
```

The adapters read the host's subscription credentials (`~/.claude/.credentials.json`, `~/.codex/auth.json`) or the environment variables above and pass them to the agent processes they start. crosscheck never writes credentials or environment variables to the run directory.

## Usage

### Interactive

```sh
cd your-repo
crosscheck
```

It asks: what to review (an existing plan or a new brief), the repository (default `.`), review focus (multiselect), optional constraints, and maximum rounds (default 3).

### Noninteractive

```sh
crosscheck plan ./PLAN.md \
  --repo . \
  --focus architecture,security \
  --rounds 3

crosscheck plan \
  --brief "Add organization-level API keys and usage limits" \
  --repo . \
  --focus architecture,security \
  --constraints "~2k orgs, Postgres + Hono already in use, ship in 2 weeks, keep the v1 API"
```

| Flag | Default | Meaning |
|---|---|---|
| `<PLAN.md>` / `--brief` / `--brief-file` | (one is required) | Review an existing plan, or have the author draft one from a brief |
| `--repo <dir>` | `.` | Repository both agents inspect |
| `--focus <list>` | `architecture,security,correctness` | Any of `architecture, security, performance, correctness, testing, maintainability` |
| `--constraints` / `--constraints-file` | none | Scale, deadlines, stack, compatibility, decisions already made |
| `--rounds <n>` | 3 | Maximum review rounds |
| `--timeout <minutes>` | 60 | Wall-clock limit for the whole run |
| `--author <provider[:model]>` | `claude-code` | `claude-code` or `codex`, optionally with a model |
| `--reviewer <provider[:model]>` | `codex` | Same |
| `--effort <level>` | runtime default | Reasoning effort, `low`, `medium`, `high`, `xhigh` or `max`, for both agents; or per role: `--effort author=high,reviewer=max` |
| `--check <command>` | none | A verification command agents may run (exact match, repeatable) |
| `--verbose` | off | Stream agent text and tool calls to stderr |

Model defaults: Claude Code uses your account's default model. For Codex, crosscheck uses the `model` in your `~/.codex/config.toml` when set, because the adapter's built-in default (`gpt-5.5`) is not available on every plan. Override either with `--author claude-code:claude-sonnet-5-5` or `--reviewer codex:gpt-6-luna`. Roles are symmetric: `--author codex --reviewer claude-code` works too.

Effort defaults: without `--effort`, Claude Code uses its default for the model, and crosscheck reads Codex's `model_reasoning_effort` from `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). The level is passed to Claude Code as `effort` (it applies with adaptive thinking) and to Codex as `reasoningEffort`. The chosen level appears in agent labels, e.g. `codex:gpt-6-luna [high] (reviewer)`, and is recorded in `run.json`. Only Codex's model and effort defaults are copied; runtime settings, hooks, MCP servers and plugins are not inherited.

Interactive mode accepts `--verbose`. Other run options require a plan or brief, so flags are never silently discarded. Empty plans/briefs and conflicting input flags are rejected.

### Progress

stderr shows one live status line (elapsed time, round, active agent, phase, finding counts, last tool call) plus milestone lines for findings raised or resolved and plan versions saved. `--verbose` streams the agents' text and tool calls instead. The full transcript is always written to the run directory; follow it with `tail -f .crosscheck/runs/<id>/transcript.jsonl`.

At the end, stdout prints the three paths you usually want:

```text
Plan:       /repo/.crosscheck/runs/20261026-151200-ab12/plan.md
Report:     /repo/.crosscheck/runs/20261026-151200-ab12/report.md
Transcript: /repo/.crosscheck/runs/20261026-151200-ab12/transcript.jsonl
```

Ctrl-C cancels cleanly: it stops the active agent, shuts down agent processes, and writes partial results. Press Ctrl-C a second time to force quit.

## How the review works

1. Record the brief/plan, constraints, focus, configuration and repository revision.
2. Brief mode only: the author inspects the repository and drafts plan `v0`.
3. **Round 1:** the reviewer independently reviews the plan and the code. It has not seen any author rebuttal at this point.
4. The author investigates each finding and accepts it (revising the plan), disputes it with evidence, or marks it `needs_user_decision`.
5. The reviewer checks the actual revised plan (full text plus a diff) and the author's evidence. It gives a verdict on every finding the author responded to and reports newly introduced problems.
6. **Later rounds:** the author responds to whatever is still unresolved, and the reviewer verifies again.

**Round counting:** a round is a reviewer pass, then the author's response/revision, then reviewer verification. The verification that ends round *n* is the reviewer pass for round *n+1*. With `--rounds 3`, the reviewer runs at most 4 times and the author at most 3 times (plus one draft turn in brief mode). If the initial review raises no material findings, the run completes in round 1 without an author turn.

Each agent keeps its own conversation (a harness session) across rounds. crosscheck passes only the current plan, a diff, the relevant findings and responses, and evidence between them; it never forwards transcripts. Peer feedback is labelled as coming from another agent, and it cannot change your requirements, permissions or limits.

### Findings ledger

Each finding has a stable ID (`F1`, `F2`, …) assigned by crosscheck, never by an agent. A finding records: originating agent, category, severity (high/medium/low), plan section or repository location, problem or failure scenario, evidence type (`repository_evidence`, `hypothetical_risk`, `missing_requirement`), evidence, assumptions, suggested correction or question, the author's response, and the reviewer's verdict with evidence. Every status change is kept in the finding's history.

| Status | Meaning | Who can set it |
|---|---|---|
| `open` | raised, or the reviewer found the fix insufficient | reviewer |
| `addressed` | the author accepted and revised; awaiting verification | author |
| `disputed` | the author disagrees, or a user decision is needed | author or reviewer |
| `verified` | the reviewer confirmed the revision resolves it (closed) | reviewer only |
| `withdrawn` | the reviewer retracted it with a reason (closed) | reviewer only |

The author cannot close a finding. A restatement of an existing finding is merged into the existing ID: the reviewer can declare `duplicate_of`, and crosscheck automatically merges matching category, location and problem text (ignoring case and whitespace). Similar wording at different locations or with different numeric limits stays separate. New evidence is retained and severity can increase; merging cannot demote a material issue to a low suggestion. A closed finding that comes back is reopened under its original ID, with stale responses and dispute counters cleared.

### Outcomes

| Outcome | When | Exit code |
|---|---|---|
| `review_complete` | no unresolved high/medium findings, the last review raised no new material issue, and any checks that ran passed | 0 |
| `needs_input` | every remaining material finding needs your decision (a product question, or a dispute the reviewer maintained twice), or a check failed | 2 |
| `budget_exhausted` | the round limit or the time limit was reached | 3 |
| `stalled` | two consecutive rounds changed neither the plan nor any finding status | 4 |
| `error` | authentication, adapter, tool or output-validation failure | 1 |
| `cancelled` | you pressed Ctrl-C | 130 |

Agreement alone does not mean the plan is correct. The report lists remaining low-severity suggestions, checks that were skipped, and the assumptions the agents stated but could not verify. If no `--check` was permitted, the report says that runtime behaviour was reasoned about, not tested.

### Output validation

Both agents return schema-validated structured output, using each runtime's native structured-output support (Claude Code `outputFormat`, Codex `outputSchema`). crosscheck then checks the output semantically: every listed finding must get a response or verdict, IDs must exist, `verified` is only valid for `addressed` findings, the revised plan must be complete with no "…unchanged" elisions, and the initial review must actually have used the repository tools. Invalid output gets one correction turn. If that also fails, the run ends with `error`. Malformed output is never treated as "no findings".

## Permissions and safety

- **The agents have no write or shell tools.** crosscheck disables each harness's built-in tools (shell, file edits, web search) and gives both agents the same host-executed tools instead:
  - `read_file`, `list_files`, `search` (git grep), confined to the repository. Symlink escapes, `.git/`, `.crosscheck/` and likely secret files (`.env*`, `*.pem`, `*.key`, SSH keys, `.npmrc`, `.netrc`) are refused. `read_file` and `list_files` allow `.env.example`, `.env.sample` and `.env.template`; search conservatively excludes all `.env*` files.
  - `git` with a narrow allowlist of subcommands and options: `log`, `show`, `diff`, `blame`, `ls-files`, `status`, `rev-parse`, `branch` and `tag` (listing only). Paths must follow `--`, and revisions must resolve to commits. Raw blob reads (`HEAD:file`, `cat-file`), `blame --contents`, configuration changes, external diff/text conversion helpers and filesystem-monitor hooks are disabled. History and diffs exclude protected paths, including environment templates; use `read_file` for those templates.
  - `run_check`, only if you pass `--check`, and only for those exact command strings. Your check commands run with your normal permissions, so only permit commands you trust in this repository.
- These rules are enforced in code (`src/agents/repo-tools.ts`), not by prompts. As a second layer, Claude Code runs in an approval-gated permission mode, and crosscheck denies any approval request it receives.
- Each runtime starts in a temporary working directory with an empty configuration directory. Host credentials are discovered by the adapters before launch; agents inspect the requested repository only through crosscheck's tools. Codex's additional capability sources (apps, plugins, hooks, subagents, browser/computer tools and skill-driven MCP installation) are disabled explicitly. Runtime directories are removed on shutdown.
- The original plan file is never modified. All plan versions are written by crosscheck itself into the run directory.
- The run directory is `<repo>/.crosscheck/`. It contains its own `.gitignore` (`*`), so it never shows up in `git status`. At the end, crosscheck compares the working tree with its state at the start and warns if anything changed.

## Output files

```text
<repo>/.crosscheck/runs/<run-id>/
  run.json            configuration, repository identity (path, branch, commit, credential-free remote), status,
                      outcome, timing, per-agent token usage/cost, checks, plan versions, round log
  findings.json       the findings ledger
  plan.md             latest plan version
  plan/v0.md, v1.md … every plan version (v0 = your original or the author's draft)
  input/              config.json, brief.md, constraints.md, plan.original.md (copy of your input)
  transcript.jsonl    turn starts, streamed activities, completed output/usage/validation, and failed turns
  events.jsonl        phases, tool calls and results, verification checks
  harness.log         diagnostics printed by the harness bridges/runtimes (kept off the terminal unless --verbose)
  report.md           concise report: outcome and why, what changed, resolved/disputed/unresolved findings,
                      decisions for you, low-severity suggestions, checks, assumptions, what was examined
```

Everything is written incrementally (ordered JSONL appends and atomic JSON rewrites), so an interrupted or failed run keeps completed work and partial streamed text. `report.md` is written even on error or cancellation when storage is available. A failed artifact write produces `error`, never a successful exit.

Usage: token counts are those the harness reports. Cost is shown only when the runtime reports one: Claude Code reports an API-equivalent estimate, Codex reports none ("n/a").

## Architecture

```text
src/cli.ts                    argument parsing, interactive prompts, summary, Ctrl-C
src/progress.ts               terminal status line and milestone log
src/orchestrator.ts           the review loop, stop rules, persistence calls
src/findings.ts               findings ledger: IDs, actor-gated status transitions, dedupe
src/schemas.ts                agent output schemas + semantic validation
src/prompts.ts                role instructions and per-turn prompts
src/store.ts / report.ts      run directory and Markdown report
src/agents/backend.ts         transport-independent AgentBackend/AgentSession interface
src/agents/harness-backend.ts HarnessAgent implementation (Claude Code + Codex adapters)
src/agents/local-sandbox.ts   host-backed sandbox session so the adapters run locally
src/agents/process.ts         process-group cancellation and bounded command output
src/agents/repo-tools.ts      read-only repository tools and their policy
spike/harness-spike.ts        the integration spike (see below)
```

The orchestrator only depends on `AgentBackend`. An ACP or native-SDK backend can be added by implementing `openSession()` and `send()`.

## Integration notes (what the spike established)

`spike/harness-spike.ts` exercises each adapter against a local repository: `bun spike/harness-spike.ts claude|codex <repo>`.

| Capability | Claude Code adapter | Codex adapter |
|---|---|---|
| Inspect a local repository | ✓ (built-in Read, or crosscheck's host tools) | ✓ via host tools (built-in shell disabled, see below) |
| Multi-turn conversation | ✓ | ✓ (same native thread while instructions/tools are unchanged) |
| Instructions and feedback | ✓ appended to the system prompt | ✓ developer instructions |
| Streaming progress | ✓ text, tool calls, usage | ✓ text, tool calls, usage |
| Permissions | ✓ `allow-reads` sends write/shell requests to the host as approval requests; denial verified | ✗ no approvals, forced `danger-full-access` (see below) |
| Cancel and clean up | ✓ abort signal, then `session.destroy()` | ✓ same |
| Validated structured output | ✓ native `outputFormat` | ✓ native `outputSchema` |

Findings that shaped the implementation:

1. **Where the adapters execute.** Both adapters run a WebSocket bridge (plus the agent CLI) "inside a sandbox" and connect to it through a sandbox-exposed port. The only published network sandbox is Vercel Sandbox, which is remote and would review an uploaded copy of the repository rather than your checkout. crosscheck implements the documented `HarnessV1NetworkSandboxSession` interface on the host (`local-sandbox.ts`): commands run as local processes in their own process group (cleanly killed on cancel), and the bridge listens on `127.0.0.1`. Runtime configuration is isolated in temporary directories, while host tools inspect the checkout. **This shim provides no OS sandbox by itself.**
2. **The Codex adapter cannot restrict its built-in tools.** It hardcodes `sandbox_mode="danger-full-access"` and `approval_policy="never"`, asserts both at thread start, and does not support approval requests, because it relies on the external sandbox for isolation. Run on the host, Codex's shell would have full access. crosscheck therefore disables every Codex built-in (which also disables Codex execution environments) and provides the read-only host tools. Repository investigation goes through those tools instead of an arbitrary shell. That is a real reduction in the reviewer's power: it can read, search and inspect git history, but it can only execute your `--check` commands.
3. **For consistency, Claude Code uses the same host tools**, with its built-ins disabled. Approval-gated permission mode stays on as a second layer.
4. **Pinned versions:** `@ai-sdk/harness@1.0.158`, `@ai-sdk/harness-claude-code@1.0.162`, `@ai-sdk/harness-codex@1.0.160`, `ai@7.0.147`. The newest releases (`harness-claude-code` ≥ 1.0.163, `harness-codex` ≥ 1.0.161) are published without `dist/bridge/pnpm-lock.yaml`, which their bootstrap reads, so session creation fails with `ENOENT`. Re-check this before upgrading.
5. **Approval continuation.** A `tool-approval-response` must be sent together with the assistant message containing the original `tool-approval-request`, or `HarnessAgent` rejects it.
6. **Native tool filtering is not configuration isolation.** The pinned Codex adapter filters four native tools, while Codex can independently load MCP servers and other capabilities. An empty `mcp_servers` table does not clear inherited entries. Separate runtime configuration/working directories and explicit capability settings prevent those sources from bypassing the host tool policy.

These limits did not justify switching to the native Claude Agent SDK or Codex SDK: everything the workflow needs works through `HarnessAgent` once tools are host-executed. If you want Codex's own OS sandbox (read-only Landlock/seatbelt) and its full shell, a native `@openai/codex-sdk` backend behind `AgentBackend` is the natural next step.

## Development

```sh
bun test            # deterministic orchestration, ledger, validation and tool-policy tests (fake agents)
bun check           # type check
bun run lint        # oxlint
bun run fmt         # oxfmt
```

The tests cover: the author cannot self-close a finding; disputes, needs-user decisions, failed checks and malformed or uninspected output never yield success; round limits, timeouts, stalls and cancellation stop correctly; IDs stay stable and restatements merge across rounds; partial results survive failures and interruption; the tool path/git/command policies.

Invalid arguments exit with code 64.

Verified with real providers (Claude Code subscription and Codex ChatGPT login, on a small Bun + SQLite fixture repo):

- Plan mode, `claude-code:claude-sonnet-5-5` author and `codex:gpt-6-luna` reviewer: the reviewer found the planted flaws (Postgres/Redis against the single-instance SQLite constraint, no 429 path out of `authenticate()`, manual-only testing). The author revised and the reviewer verified, ending `review_complete` in about 2m40s.
- A two-round run with a dispute: the author disputed a finding, and the reviewer tried to "verify" it. Validation rejected that, and the correction turn withdrew it instead.
- Another run ended `needs_input` when the reviewer escalated a product question (fixed-window burst tolerance).
- Brief mode with swapped roles (Codex as author, Claude Code as reviewer).
- Ctrl-C mid-review: exit 130, bridge processes terminated, `run.json`/`report.md` recorded `cancelled`, and plan v0 was kept.
- Interactive prompts, driven through a pseudo-terminal.
- In every run the fixture's `git status` stayed clean.

Additional review verification (2026-10-26): a real Claude Code author / Codex reviewer run using the isolated runtime configuration found a planted arithmetic error, revised and verified the plan, executed the permitted `bun test` twice successfully, and ended `review_complete` in 34 seconds. The input plan and fixture working tree remained unchanged. A separate real CLI interruption during startup exited 130 and preserved plan v0 and a cancellation report.

Deterministic regression tests also cover protected Git history/blob access, external diff helpers, startup cancellation, process descendants that ignore SIGTERM, failed report writes, partial transcripts, severity escalation during deduplication, invalid CLI input, and edits to existing untracked files. API-key (non-subscription) authentication and a real-provider run reaching the time limit remain untested.

Real smoke test (uses both providers and spends tokens):

```sh
crosscheck plan PLAN.md --repo . --rounds 2 \
  --author claude-code:claude-sonnet-5-5 --reviewer codex:gpt-6-luna --check "bun test" --verbose
```

## Known limitations

- The agents' repository access is crosscheck's tool set, not each agent's native toolbox. They cannot run arbitrary read-only commands such as `ls -R` or `rg --type`, only the `--check` commands you permit.
- `--check` commands run unsandboxed as your user; tests that write caches or snapshots can modify the working tree (crosscheck warns if that happens).
- The local sandbox shim depends on an experimental interface; pinned versions are required.
- The adapters install their runtimes into `~/.ai-sdk-harness/`. Host login credentials may be refreshed by the adapters; runtime settings, caches and conversations use temporary configuration directories.
- Automatic duplicate detection requires matching category, location and problem text. Semantic paraphrases depend on the reviewer's `duplicate_of`; heavily reworded restatements can still appear as new findings.
- One run at a time per repository is assumed; runs never share state, but concurrent runs share `~/.ai-sdk-harness`.
