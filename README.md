# crosscheck

[![CI](https://github.com/brielov/crosscheck/actions/workflows/ci.yml/badge.svg)](https://github.com/brielov/crosscheck/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/brielov/crosscheck)](https://github.com/brielov/crosscheck/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Have two coding agents review a plan against your actual repository.**

You write a plan with one AI, paste it into another for review, and copy the feedback back. crosscheck automates that loop. An **author** agent (Claude Code by default) writes or revises the plan, and a **reviewer** agent (Codex by default) checks it against your code. Both investigate the repository themselves, read-only. crosscheck runs the rounds, tracks every finding until the reviewer has verified or withdrawn it, and stops with an explicit outcome and a report.

```text
$ crosscheck plan PLAN.md --focus architecture,correctness,testing \
    --constraints "Single instance, ~50 keys, no new infrastructure; ship this week"
▸ Round 1 · codex (reviewer): independent review
  + F1 [high/architecture] The proposed storage and cache conflict with the deployment constraints
  + F2 [medium/correctness] The plan does not define how a rate-limit rejection becomes HTTP 429
  + F3 [low/testing] The test plan does not pin down threshold and rejection behavior
▸ Round 1 · claude-code (author): responding to 3 finding(s)
  ✎ plan v1 saved .crosscheck/runs/20261026-164111-5548/plan/v1.md
  ! author accepted 3, disputed 0, asked you to decide 0; plan v0 → v1
▸ Round 1 · codex (reviewer): verifying revision
  ✓ F1 verified
  ✓ F2 verified
  ✓ F3 verified

Outcome: review_complete: no unresolved high/medium findings and the last review raised no new material issues
Plan:       .crosscheck/runs/20261026-164111-5548/plan.md
Report:     .crosscheck/runs/20261026-164111-5548/report.md
```

- **Grounded in your code.** Both agents read files, search, and inspect git history before making claims. Each finding says whether it rests on repository evidence, is a hypothetical risk, or points at a missing requirement.
- **Honest disagreement.** The author can dispute feedback, and the reviewer can withdraw a finding. Only the reviewer can close one. Disputes that need your judgment are escalated to you, not papered over.
- **Your constraints win.** Scale, deadlines, stack and decisions you've already made go to both agents, which are told to avoid complexity you didn't ask for.
- **Safe by construction.** Neither agent can modify your repository or run commands, except the verification commands you explicitly allow.

## Install

**Homebrew** (macOS and Linux):

```sh
brew install brielov/tap/crosscheck
```

**Prebuilt binary:** download the archive for your platform from the [latest release](https://github.com/brielov/crosscheck/releases/latest), verify it against `checksums.txt`, and put `crosscheck` on your `PATH`. Builds exist for macOS and Linux, on arm64 and x64.

**From source** (requires [Bun](https://bun.sh) 1.3+):

```sh
git clone https://github.com/brielov/crosscheck && cd crosscheck
bun install
bun run build          # writes dist/<os>-<arch>/crosscheck
# or run it directly: bun src/cli.ts --help
```

## Setup

crosscheck drives the Claude Code and Codex agents, so it needs:

- **Node.js 20+ and git** on your `PATH`. The agent bridges run with `node`; the Homebrew formula installs it for you.
- **Accounts:** a Claude subscription login (`claude`, then `/login`) or `ANTHROPIC_API_KEY`, and a ChatGPT login (`codex login`) or `OPENAI_API_KEY`. crosscheck uses the credentials those CLIs already store and never writes them to its run files.
- **About 1.6 GB of disk and a network connection on the first run.** The pinned Claude Code and Codex runtimes are downloaded once into `~/.ai-sdk-harness/` and reused.

Check everything with:

```sh
crosscheck doctor
```

It verifies Node, git, both logins and the Codex defaults, and whether the agent runtimes are installed. It starts no agents and spends no tokens.

## Usage

Run `crosscheck` inside a repository for a short interactive setup: what to review, focus areas, constraints and number of rounds. Or pass everything as flags:

```sh
# Review an existing plan (the file is never modified)
crosscheck plan ./PLAN.md --focus architecture,security --rounds 3

# Have the author draft a plan from a brief first
crosscheck plan \
  --brief "Add organization-level API keys and usage limits" \
  --constraints "~2k orgs, Postgres + Hono already in use, ship in 2 weeks, keep the v1 API" \
  --focus architecture,security
```

| Flag | Default | Meaning |
|---|---|---|
| `<PLAN.md>`, `--brief`, `--brief-file` | one is required | Review an existing plan, or have the author draft one from a brief |
| `--repo <dir>` | `.` | Repository both agents inspect |
| `--focus <list>` | `architecture,security,correctness` | Any of `architecture`, `security`, `performance`, `correctness`, `testing`, `maintainability` |
| `--constraints`, `--constraints-file` | none | Scale, deadlines, stack, compatibility, decisions already made |
| `--rounds <n>` | 3 | Maximum review rounds |
| `--timeout <minutes>` | 60 | Time limit for the whole run |
| `--author <provider[:model]>` | `claude-code` | `claude-code` or `codex`, optionally with a model, e.g. `claude-code:claude-sonnet-5-5` |
| `--reviewer <provider[:model]>` | `codex` | Same. Roles are interchangeable. |
| `--effort <level>` | runtime default | Reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`) for both agents, or per role: `author=high,reviewer=max` |
| `--check <command>` | none | A verification command the agents may run, such as `"bun test"`. Exact match; repeatable. |
| `--verbose` | off | Stream agent text and tool calls to the terminal |

Defaults: Claude Code uses your account's default model. For Codex, crosscheck takes `model` and `model_reasoning_effort` from `~/.codex/config.toml`, because the adapter's built-in default model isn't available on every plan.

While it runs, a status line shows the round, the active agent, its phase, finding counts and elapsed time. Press **Ctrl-C** to cancel: agents are stopped and partial results are saved. Press it again to force quit.

### Outcomes

Every run ends with one of these outcomes, and each has its own exit code for scripting:

| Outcome | Meaning | Exit |
|---|---|---|
| `review_complete` | No unresolved high/medium findings, the last review raised nothing new, and any checks that ran passed | 0 |
| `needs_input` | What remains needs your decision: a product question, a dispute the agents can't settle, or a failed check | 2 |
| `budget_exhausted` | The round or time limit was reached | 3 |
| `stalled` | Two rounds in a row changed neither the plan nor any finding | 4 |
| `error` | Authentication, agent, tool or output-validation failure | 1 |
| `cancelled` | You pressed Ctrl-C | 130 |

A round is a reviewer pass, the author's response and revision, then reviewer verification. Agreement alone isn't proof: the report also lists remaining low-severity suggestions, checks that were skipped, and assumptions the agents couldn't verify.

### What you get

Each run writes to `<repo>/.crosscheck/runs/<run-id>/`. That directory ignores itself, so it never shows up in `git status`.

```text
plan.md            the latest plan (every version is in plan/v0.md, v1.md, …)
report.md          outcome and why, what changed, resolved/disputed/open findings,
                   decisions for you, checks, assumptions, what was examined
findings.json      the findings ledger
transcript.jsonl   every agent turn: prompts, streamed text, tool calls, output, usage
run.json           configuration, repository revision, timing, token usage and cost
```

Results are saved as the run progresses, so an interrupted or failed run keeps its work.

## Permissions and safety

- **No write or shell access.** The agents' built-in tools (shell, file edits, web) are disabled. Both get the same read-only tools, executed by crosscheck itself:
  - read, list and search files inside the repository;
  - a restricted set of read-only `git` commands;
  - `run_check`, which runs only the exact commands you passed with `--check`.
- **Enforced in code, not prompts.** Access outside the repository, symlink escapes, `.git/`, crosscheck's own run files, and likely secrets (`.env*`, keys, `.npmrc`, …) are refused, including through git history.
- **Isolated agent runtimes.** Each agent starts with an empty configuration, so your MCP servers, hooks and plugins aren't loaded into it.
- **Your files stay untouched.** Your plan file is never modified. At the end crosscheck compares the working tree with its starting state and warns if anything changed (for example, a `--check` command that writes files).

The design and its trade-offs are covered in [docs/design.md](docs/design.md). Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Limitations

- Agents investigate through crosscheck's tools, not their native toolboxes, so they can't run ad-hoc commands such as `rg` or `ls -R`.
- `--check` commands run as you, without a sandbox. Only allow commands you trust in that repository.
- The agent adapters are experimental. crosscheck pins exact versions and needs deliberate upgrades.
- Linux and macOS only.

## Documentation

- [docs/design.md](docs/design.md): how the review loop, findings ledger and validation work, and what the integration spike established
- [docs/development.md](docs/development.md): running the tests, releasing, and upgrading the agent adapters
- [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE)
