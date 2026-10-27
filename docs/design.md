# Design

This document explains how crosscheck works and why. For installation and usage, see the [README](../README.md).

## The review loop

The CLI owns the outer workflow. Each agent's harness owns its internal reasoning and tool calls. The goal is the best plan both agents can agree on, so the loop is a discussion that runs until every point is settled and a fresh look finds nothing material left.

1. Record the brief or plan, constraints, focus areas, configuration and repository revision.
2. Brief mode only: the author inspects the repository and drafts plan `v0`.
3. Every round has the same shape:
   - **Full review, when nothing is under discussion.** Both agents start new sessions. The reviewer reads the whole plan and the code, covering every section and focus area, and raises points. It is told which points are already settled so it doesn't repeat them. It can reopen one of its own only with new evidence.
   - **The author's turn.** The author answers each of the reviewer's points: accept (and revise the plan), dispute with evidence, or `needs_user_decision`. It rules on its own points the reviewer disputed. Then it critiques the plan itself and raises its own points, including problems the reviewer missed or earlier changes it now disagrees with, applying each change in the revision. In a full-review round it reads the whole plan with fresh eyes first.
   - **The reviewer's check.** The reviewer sees the revised plan (full text plus a diff). It rules on the author's answers to its points, answers the author's own points, and raises problems the revision introduced. It is skipped when nothing waits for it and the plan didn't change.
4. A round that starts while points are still being discussed skips the full review and continues the discussion in the same sessions.

**Round counting.** A round is the optional full review, the author's turn, and the reviewer's check. The defaults are 8 rounds and 3 hours, because a thorough run needs at least two full reviews: one that raises points and one that comes back clean.

**Separate conversations.** Each agent has its own harness session. Sessions last until the next full review, which starts both agents fresh so neither grades its own earlier work from memory. crosscheck passes only the current plan, a diff, the relevant points and answers, and evidence between them; it never forwards transcripts. Peer feedback is labelled as coming from another agent, and it cannot change the user's requirements, permissions or limits. Both agents are told never to agree just to finish and never to invent objections.

**Resuming.** `crosscheck resume` reloads a stopped run's state, points and plan versions and continues in the same directory. Both agents start fresh sessions; the points carry the discussion. If the run stopped after the author's turn but before the reviewer's check, that check runs first, in the same round. Whether the last full review was clean is saved with the run, so a resumed run still needs a clean full review before it can complete. Elapsed time adds up across resumes, while the time limit applies to each session.

**Effort balance.** When one agent's reasoning effort is two or more levels below the other's, crosscheck warns before the run starts. In practice a much weaker author accepts whatever the reviewer says.

## Points ledger

Each point has a stable ID (`F1`, `F2`, …) assigned by crosscheck, never by an agent. Either agent can raise one. A point records:

- which agent raised it;
- category and severity (high, medium or low);
- the plan section or repository location;
- the problem or failure scenario;
- evidence type: `repository_evidence`, `hypothetical_risk` or `missing_requirement`;
- the evidence and assumptions;
- a suggested correction, or a question that must be answered;
- the other agent's latest answer, and the raiser's latest ruling, each with evidence;
- whose move it is: the author, the reviewer, or nobody (closed, or waiting for you).

Every status change is kept in the point's history.

| Status | Meaning |
|---|---|
| `open` | Raised, or the raiser found the fix insufficient; the other agent must answer |
| `addressed` | The author accepted a reviewer's point and revised; the reviewer must verify |
| `disputed` | The other agent disagrees, or a decision is needed from you |
| `verified` | Closed: the reviewer verified the author's fix, or accepted the author's own change |
| `withdrawn` | Closed: the agent that raised it retracted it, with a reason |

**Only the raiser closes a point.** The other agent can accept, dispute or escalate, but never close. A reviewer's point closes when the reviewer verifies the author's fix or withdraws the point. When the author raises a point it has already changed the plan, so the reviewer accepting that change closes it. Otherwise the author withdraws it, reverting the change.

**Disputes.** When the other agent disputes a point, its raiser must withdraw it, maintain it with evidence, or escalate it as a decision for you. A disputed reviewer point can't be marked `verified`. After three maintained disputes the point goes to you.

**Every severity counts.** Low-severity points must be settled like any other, so agents are told to raise them only when they want the change.

**Duplicates.** A restatement of an existing point by the same agent is merged into the existing ID. The agent can declare it with `duplicate_of`, and crosscheck also merges points whose category, location and problem text match exactly (ignoring case and whitespace). Similar wording at different locations, or with different numeric limits, stays separate. A merge keeps the new evidence, and severity can only go up, so a material issue is never demoted to a suggestion. A closed point that comes back is reopened under its original ID, with stale answers and dispute counters cleared. One agent can't restate the other's point as its own: it answers that point or raises a separate one.

## Stopping rules

The outcomes are listed in the [README](../README.md#outcomes). The rules behind them:

- **`review_complete`:** no point is still under discussion, the most recent full review (by both agents) raised nothing material, no material point has been raised since, and the latest result of every verification check that ran passed.
- **`needs_input`:** the same, except that some points are waiting for your decision (a product question, or a dispute maintained three times), or a verification check failed.
- **`stalled`:** two consecutive rounds changed neither the plan nor any point's status.
- **`budget_exhausted`:** the round or time limit was reached. The reason says whether points were still under discussion or the last full review hadn't come back clean.

Agreement alone isn't proof of correctness. The report always lists skipped checks and the agents' unverified assumptions. If no `--check` was permitted, it says runtime behaviour was reasoned about, not tested.

## Model checks

The harness adapters pass the model name through untouched, so a typo used to surface only when that agent first ran, possibly minutes into a run. crosscheck now asks the runtimes directly, without starting a conversation:

- **Codex:** `codex app-server` and its `model/list` request. It runs with your own `CODEX_HOME`, so the list matches your login and plan. Hidden models are accepted but not offered.
- **Claude Code:** the model table in the `initialize` control response of `claude -p --input-format stream-json`. It runs with an empty config directory. The table doesn't depend on the login. Aliases (`opus`) fold into full ids (`claude-opus-5-5`).

It uses the pinned runtime in `~/.ai-sdk-harness/`, or the one on `PATH` before the first run.

**Unknown models:**

- A model that matches a listed one after normalizing case and punctuation (`opus-5.5`), or is a near-miss spelling of one, is rejected with a suggestion.
- Claude Code also accepts full ids it no longer lists, so a well-formed `claude-…` id that differs only in its version digits passes with a warning.

**Effort levels** are checked against what the chosen model supports.

**If a list can't be loaded,** crosscheck warns and lets the runtime decide, as before.

## Output validation

Both agents return structured output, validated by each runtime's native support (Claude Code `outputFormat`, Codex `outputSchema`). crosscheck then checks the output semantically:

- every point waiting for an agent gets exactly one answer or ruling from it, and every ID exists;
- an agent answers only the other agent's points and rules only on its own;
- `verified` is only valid for an `addressed` point;
- rulings and points carry evidence;
- a revised plan is complete, with no "…unchanged" elisions, and the author's own points come with that revision;
- every full review actually used the repository tools.

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
  findings.json       the points ledger
  plan.md             latest plan version
  plan/v0.md, v1.md … every plan version (v0 = your original or the author's draft)
  input/              config.json, brief.md, constraints.md, plan.original.md (copy of your input)
  transcript.jsonl    turn starts, streamed text (batched), tool activity, completed output/usage/validation,
                      failed turns
  events.jsonl        phases, tool calls and results, verification checks
  harness.log         diagnostics printed by the agent bridges (shown on the terminal only with --verbose)
  report.md           outcome and why, next steps, what changed, settled and open points, decisions for you,
                      checks, assumptions, what was examined
```

Everything is written incrementally: JSONL files are appended in order and JSON files are rewritten atomically. An interrupted or failed run keeps its completed work, including partial streamed text. A failed artifact write produces `error`, never a successful exit.

Token counts are the ones each harness reports. Cost appears only when the runtime reports it: Claude Code gives an API-equivalent estimate, and Codex reports none.

## Architecture

```text
src/cli.ts                    entry point: subcommands, summary, Ctrl-C
src/options.ts                flag parsing, defaults, the equivalent command line
src/setup.ts                  guided setup, model/effort resolution against the catalogs
src/models.ts                 model catalogs from the agent runtimes, typo suggestions
src/doctor.ts                 `crosscheck doctor` preflight checks
src/progress.ts               terminal status line and milestone log
src/orchestrator.ts           the review loop, stop rules, persistence calls
src/findings.ts               points ledger: IDs, whose move it is, raiser-only closing, dedupe
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
