# Design

This document explains how crosscheck works and why. For installation and usage, see the [README](../README.md).

## The review loop

The CLI owns the outer workflow. Each agent's harness owns its internal reasoning and tool calls.

1. Record the brief or plan, constraints, focus areas, configuration and repository revision.
2. Brief mode only: the author inspects the repository and drafts plan `v0`.
3. **Round 1:** the reviewer independently reviews the plan and the code. At this point it has seen no author rebuttal.
4. The author investigates each finding and either accepts it (revising the plan), disputes it with evidence, or marks it `needs_user_decision`.
5. The reviewer checks the actual revised plan (full text plus a diff) against the author's evidence. It gives a verdict on every finding the author responded to and reports newly introduced problems.
6. **Later rounds:** the author responds to whatever is still unresolved, and the reviewer verifies again.

**Round counting.** A round is a reviewer pass, then the author's response/revision, then reviewer verification. The verification that ends round *n* is the reviewer pass for round *n+1*. With `--rounds 3`, the reviewer runs at most 4 times and the author at most 3 times (plus one draft turn in brief mode). If the initial review raises no material findings, the run completes in round 1 without an author turn.

**Separate conversations.** Each agent keeps its own conversation (a harness session) across rounds. crosscheck passes only the current plan, a diff, the relevant findings and responses, and evidence between them; it never forwards transcripts. Peer feedback is labelled as coming from another agent, and it cannot change the user's requirements, permissions or limits. The author is told never to accept incorrect feedback just to finish. The reviewer is told not to invent objections and to withdraw findings the author shows to be wrong.

## Findings ledger

Each finding has a stable ID (`F1`, `F2`, …) assigned by crosscheck, never by an agent. A finding records:

- the originating agent;
- category and severity (high, medium or low);
- the plan section or repository location;
- the problem or failure scenario;
- evidence type: `repository_evidence`, `hypothetical_risk` or `missing_requirement`;
- the evidence and assumptions;
- a suggested correction, or a question that must be answered;
- the author's response, and the reviewer's verdict with its evidence.

Every status change is kept in the finding's history.

| Status | Meaning | Who can set it |
|---|---|---|
| `open` | Raised, or the reviewer found the fix insufficient | reviewer |
| `addressed` | The author accepted and revised; awaiting verification | author |
| `disputed` | The author disagrees, or a user decision is needed | author or reviewer |
| `verified` | The reviewer confirmed the revision resolves it (closed) | reviewer only |
| `withdrawn` | The reviewer retracted it with a reason (closed) | reviewer only |

**Disputes.** The author can never close a finding. When the author disputes one, the reviewer must rule on it:

- **withdraw** it, because the author was right;
- **maintain** it, with its own evidence;
- **escalate** it as a user decision.

The reviewer cannot mark a disputed finding `verified`. A dispute the reviewer maintains twice becomes a decision for you.

**Duplicates.** A restatement of an existing finding is merged into the existing ID. The reviewer can declare it with `duplicate_of`, and crosscheck also merges findings whose category, location and problem text match exactly (ignoring case and whitespace). Similar wording at different locations, or with different numeric limits, stays separate. A merge keeps the new evidence, and severity can only go up, so a material issue is never demoted to a suggestion. A closed finding that comes back is reopened under its original ID, with stale responses and dispute counters cleared.

## Stopping rules

The outcomes are listed in the [README](../README.md#outcomes). The rules behind them:

- **`review_complete`:** no unresolved high or medium findings, the last reviewer pass raised no new material issue, and the latest result of every verification check that ran passed. Low-severity findings never block completion.
- **`needs_input`:** every remaining material finding is a dispute that only you can settle (a product decision, or a disagreement the reviewer maintained twice), or a verification check failed.
- **`stalled`:** two consecutive rounds changed neither the plan nor any finding status.
- **`budget_exhausted`:** the round or time limit was reached.

The report always lists remaining low-severity suggestions, skipped checks and the agents' unverified assumptions. If no `--check` was permitted, it says runtime behaviour was reasoned about, not tested.

## Output validation

Both agents return structured output, validated by each runtime's native support (Claude Code `outputFormat`, Codex `outputSchema`). crosscheck then checks the output semantically:

- every listed finding gets exactly one response or verdict, and every ID exists;
- `verified` is only valid for an `addressed` finding;
- verdicts and findings carry evidence;
- a revised plan is complete, with no "…unchanged" elisions;
- the initial review actually used the repository tools.

Invalid output gets one correction turn. If that also fails, the run ends with `error`. Malformed output is never interpreted as "no findings".

## Permissions model

The agents never get write or shell access. Both use the same host-executed tools, defined in `src/agents/repo-tools.ts`:

- **`read_file`, `list_files`, `search` (git grep)** are confined to the repository. Refused:
  - symlink escapes, `.git/` and `.crosscheck/`;
  - likely secret files: `.env*`, `*.pem`, `*.key`, SSH keys, `.npmrc`, `.netrc`.

  `read_file` and `list_files` allow `.env.example`, `.env.sample` and `.env.template`; `search` excludes every `.env*` file.
- **`git`** is limited to an allowlist of subcommands and options: `log`, `show`, `diff`, `blame`, `ls-files`, `status`, `rev-parse`, plus listing-only `branch` and `tag`. Paths must follow `--`, and revisions must resolve to commits. These are disabled:
  - raw blob reads (`HEAD:file`, `cat-file`) and `blame --contents`;
  - configuration changes;
  - external diff and text-conversion helpers;
  - filesystem-monitor hooks.

  History and diffs exclude protected paths.
- **`run_check`** exists only when `--check` is given, and runs only those exact command strings.

These rules are enforced in code, not prompts. As a second layer, Claude Code runs in an approval-gated permission mode, and crosscheck denies any approval request it receives.

Each agent runtime starts in a temporary working directory with empty configuration directories (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`), so your settings, MCP servers, hooks and plugins don't apply. The adapters discover your credentials on the host before launch and pass them to the runtime. Codex's additional capability sources (apps, plugins, hooks, subagents, browser and computer tools, skill-driven MCP installation) are disabled explicitly. Runtime directories are removed on shutdown.

## Run directory

```text
<repo>/.crosscheck/runs/<run-id>/
  run.json            configuration, repository identity (path, branch, commit, credential-free remote), status,
                      outcome, timing, per-agent token usage/cost, checks, plan versions, round log
  findings.json       the findings ledger
  plan.md             latest plan version
  plan/v0.md, v1.md … every plan version (v0 = your original or the author's draft)
  input/              config.json, brief.md, constraints.md, plan.original.md (copy of your input)
  transcript.jsonl    turn starts, streamed text (batched), tool activity, completed output/usage/validation,
                      failed turns
  events.jsonl        phases, tool calls and results, verification checks
  harness.log         diagnostics printed by the agent bridges (shown on the terminal only with --verbose)
  report.md           outcome and why, what changed, resolved/disputed/unresolved findings, decisions for you,
                      low-severity suggestions, checks, assumptions, what was examined
```

Everything is written incrementally: JSONL files are appended in order and JSON files are rewritten atomically. An interrupted or failed run keeps its completed work, including partial streamed text. A failed artifact write produces `error`, never a successful exit.

Token counts are the ones each harness reports. Cost appears only when the runtime reports it: Claude Code gives an API-equivalent estimate, and Codex reports none.

## Architecture

```text
src/cli.ts                    argument parsing, interactive prompts, summary, Ctrl-C
src/doctor.ts                 `crosscheck doctor` preflight checks
src/progress.ts               terminal status line and milestone log
src/orchestrator.ts           the review loop, stop rules, persistence calls
src/findings.ts               findings ledger: IDs, actor-gated status transitions, dedupe
src/schemas.ts                agent output schemas + semantic validation
src/prompts.ts                role instructions and per-turn prompts
src/store.ts, src/report.ts   run directory and Markdown report
src/agents/backend.ts         transport-independent AgentBackend/AgentSession interface
src/agents/harness-backend.ts HarnessAgent implementation (Claude Code + Codex adapters)
src/agents/local-sandbox.ts   host-backed sandbox session so the adapters run locally
src/agents/process.ts         process-group cancellation and bounded command output
src/agents/repo-tools.ts      read-only repository tools and their policy
scripts/build.ts              standalone executables (embeds the adapters' bridge files)
spike/harness-spike.ts        the adapter integration spike
```

The orchestrator depends only on `AgentBackend`. An ACP or native-SDK backend can be added by implementing `openSession()` and `send()`.

## Integration notes

crosscheck uses the [AI SDK harness](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview) `HarnessAgent` with the Claude Code and Codex adapters. `spike/harness-spike.ts` exercises each adapter against a local repository (`bun spike/harness-spike.ts claude|codex <repo>`).

| Capability | Claude Code adapter | Codex adapter |
|---|---|---|
| Inspect a local repository | ✓ | ✓ through host tools (built-in shell disabled, see below) |
| Multi-turn conversation | ✓ | ✓ (same native thread while instructions and tools are unchanged) |
| Instructions and feedback | ✓ appended to the system prompt | ✓ developer instructions |
| Streaming progress | ✓ text, tool calls, usage | ✓ text, tool calls, usage |
| Permissions | ✓ `allow-reads` sends write/shell requests to the host as approval requests | ✗ no approvals, forced `danger-full-access` |
| Cancel and clean up | ✓ abort signal, then `session.destroy()` | ✓ same |
| Validated structured output | ✓ native `outputFormat` | ✓ native `outputSchema` |

Findings that shaped the implementation:

1. **Where the adapters execute.** Both adapters run a WebSocket bridge (plus the agent CLI) "inside a sandbox" and connect to it through a sandbox-exposed port. The only published network sandbox is Vercel Sandbox. It is remote, so the agents would review an uploaded copy of the repository rather than your checkout. crosscheck implements the documented `HarnessV1NetworkSandboxSession` interface on the host (`local-sandbox.ts`):
   - commands run as local processes in their own process group, so they are cleanly killed on cancel;
   - the bridge listens on `127.0.0.1`.

   **This shim provides no OS sandbox by itself.**
2. **The Codex adapter cannot restrict its built-in tools.** It hardcodes `sandbox_mode="danger-full-access"` and `approval_policy="never"` and asserts both at thread start, because it relies on the external sandbox for isolation. Run on the host, Codex's shell would have full access. crosscheck therefore disables every Codex built-in (which also disables Codex execution environments) and provides the read-only host tools. This is a real reduction in the reviewer's power: it can read, search and inspect git history, but it can execute only the `--check` commands.
3. **For consistency, Claude Code uses the same host tools**, with its built-ins disabled.
4. **Approval continuation.** A `tool-approval-response` must be sent together with the assistant message containing the original `tool-approval-request`, or `HarnessAgent` rejects it.
5. **Native tool filtering is not configuration isolation.** Codex can load MCP servers and other capabilities independently of the four native tools the adapter filters, and an empty `mcp_servers` table does not clear inherited entries. Separate runtime configuration directories and explicit capability settings prevent those sources from bypassing the tool policy.
6. **Pinned versions.** See [docs/development.md](development.md#upgrading-the-agent-adapters).
7. **Standalone binaries.** The adapters load their bridge files with `readFile(new URL("./bridge/…", import.meta.url))`, which `bun build --compile` doesn't embed. `scripts/build.ts` rewrites those references into embedded-file imports. At runtime, a `pnpm` shim uses the binary itself as Bun (`BUN_BE_BUN=1`) to install the agent runtimes.

None of these limits justified switching to the native Claude Agent SDK or Codex SDK: everything the workflow needs works through `HarnessAgent` once tools are host-executed. If you want Codex's own OS sandbox (read-only Landlock/Seatbelt) and its full shell, a native `@openai/codex-sdk` backend behind `AgentBackend` is the natural next step.
