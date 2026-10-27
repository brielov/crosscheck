# crosscheck

[![CI](https://github.com/brielov/crosscheck/actions/workflows/ci.yml/badge.svg)](https://github.com/brielov/crosscheck/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/brielov/crosscheck)](https://github.com/brielov/crosscheck/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Have two coding agents review a plan against your actual repository.**

You write a plan with one AI, paste it into another for review, and copy the feedback back. crosscheck automates that loop. An **author** agent (Claude Code by default) writes and revises the plan, and a **reviewer** agent (Codex by default) critiques it against your code. Both investigate the repository themselves, read-only, and both raise points. They discuss each point until they agree on it, or hand it to you. The run finishes only when a full review by both agents, each in a fresh session, finds nothing material left to change. crosscheck stops with an explicit outcome and a report.

```text
$ crosscheck plan PLAN.md --focus architecture,correctness,testing \
    --constraints "Single instance, ~50 keys, no new infrastructure; ship this week"
▸ Round 1 · codex (reviewer): full review
  + F1 [high/architecture, reviewer] The proposed storage and cache conflict with the deployment constraints
  + F2 [medium/correctness, reviewer] The plan does not define how a rate-limit rejection becomes HTTP 429
▸ Round 1 · claude-code (author): answering 2 point(s) and critiquing the plan
  + F3 [medium/testing, author] The test plan does not pin down threshold and rejection behavior
  ✎ plan v1 saved .crosscheck/runs/20261026-164111-5548/plan/v1.md
  ! author accepted 1, disputed 1, asked you to decide 0, raised 1 of its own; plan v0 → v1
▸ Round 1 · codex (reviewer): checking the author's turn
  ✓ F1 verified
  ✓ F3 verified
▸ Round 2 · claude-code (author): answering 1 point(s) and critiquing the plan
  ! author accepted 1, disputed 0, asked you to decide 0, raised 0 of its own; plan v1 → v2
▸ Round 2 · codex (reviewer): checking the author's turn
  ✓ F2 verified
▸ Round 3 · codex (reviewer): full review
  no new points, none settled
▸ Round 3 · claude-code (author): critiquing the plan
  no new points, none settled

Outcome: review_complete: both agents agree on every point, and their last full review found nothing material to change

Next steps:
  1. Review what changed:
       diff -u PLAN.md .crosscheck/runs/20261026-164111-5548/plan.md
  2. If you agree, adopt the revised plan (crosscheck never edits your file):
       cp .crosscheck/runs/20261026-164111-5548/plan.md PLAN.md

Plan:       .crosscheck/runs/20261026-164111-5548/plan.md
Report:     .crosscheck/runs/20261026-164111-5548/report.md
```

- **Grounded in your code.** Both agents read files, search, and inspect git history before making claims. Each finding says whether it rests on repository evidence, is a hypothetical risk, or points at a missing requirement.
- **A real discussion.** Either agent can raise a point, including the author objecting to its own earlier changes. The other agent accepts or disputes it with evidence, and only the agent that raised a point can close it. Every point counts, low-severity ones included. Disputes the agents can't settle, and product decisions, go to you instead of being papered over.
- **Fresh eyes until nothing is left.** Whenever nothing is under discussion, both agents start new sessions and re-read the whole plan. The run completes only when such a full review raises nothing material.
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
- **Login checks:** before any agent starts, crosscheck checks both logins with requests that spend no tokens. It uses Anthropic's and OpenAI's model lists, or Codex's own usage-limit lookup for a ChatGPT login. A missing or rejected login stops the run right away instead of after another agent's turn. It also warns when a login token expires before the run's time limit, or when your Codex plan's usage limit is reached. `crosscheck doctor` runs the same checks.
- **Long runs on a Claude subscription:** each agent session starts with your current login token, and those tokens expire every few hours. If one expires mid-turn, crosscheck retries that turn once in a fresh session, which loses the work the turn had done. To avoid that entirely, create a long-lived token with `claude setup-token` and export it as `CLAUDE_CODE_OAUTH_TOKEN` before running crosscheck.
- **About 1.6 GB of disk and a network connection on the first run.** The pinned Claude Code and Codex runtimes are downloaded once into `~/.ai-sdk-harness/` and reused.

Check everything with:

```sh
crosscheck doctor
```

It verifies Node, git, both logins, the Codex defaults and the model lists, and whether the agent runtimes are installed. It starts no agents and spends no tokens.

## Usage

Run `crosscheck` inside a repository and it walks you through the setup:

- **Input:** what to review. It offers the Markdown plans it finds, or takes a brief for the author to turn into a plan.
- **Agents:** author and reviewer, each a model picked from the lists Claude Code and Codex report for your account, plus a reasoning effort the model supports.
- **Review settings:** focus areas and constraints.
- **Checks:** the verification commands the agents may run. It suggests the ones it detects, such as `bun run test`.
- **Limits:** number of rounds and time limit.

It then shows a summary and the equivalent command line, and asks before starting.

Or pass everything as flags:

```sh
# Review an existing plan (the file is never modified)
crosscheck plan ./PLAN.md --focus architecture,security --rounds 3

# Have the author draft a plan from a brief first
crosscheck plan \
  --brief "Add organization-level API keys and usage limits" \
  --constraints "~2k orgs, Postgres + Hono already in use, ship in 2 weeks, keep the v1 API" \
  --focus architecture,security
```

You can mix the two:

- flags given without a plan or brief fill in their answers, and the setup asks only for the rest;
- `-i` asks for the rest even when a plan or brief is given.

**Models are checked before anything starts.** crosscheck asks each agent runtime which models and effort levels it accepts. This takes about a second and spends no tokens. A typo such as `--author claude-code:opus-5.5` stops right away with `Did you mean claude-opus-5-5?`. In a terminal, you pick from the list instead. `crosscheck models` prints both lists.

| Flag | Default | Meaning |
|---|---|---|
| `<PLAN.md>`, `--brief`, `--brief-file` | asked for | Review an existing plan, or have the author draft one from a brief |
| `--repo <dir>` | `.` | Repository both agents inspect |
| `--focus <list>` | `architecture,security,correctness` | Any of `architecture`, `security`, `performance`, `correctness`, `testing`, `maintainability` |
| `--constraints`, `--constraints-file` | none | Scale, deadlines, stack, compatibility, decisions already made |
| `--rounds <n>` | 8 | Maximum rounds |
| `--timeout <minutes>` | 180 | Time limit for the whole run |
| `--author <provider[:model]>` | `claude-code` | `claude-code` or `codex`, optionally with a model or alias, e.g. `claude-code:sonnet` |
| `--reviewer <provider[:model]>` | `codex` | Same. Roles are interchangeable. |
| `--effort <level>` | runtime default | Reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`) for both agents, or per role: `author=high,reviewer=max` |
| `--check <command>` | none | A verification command the agents may run, such as `"bun test"`. Exact match; repeatable. |
| `-i`, `--interactive` | off | Ask for the remaining settings even when a plan or brief is given |
| `--verbose` | off | Stream agent text and tool calls to the terminal |

Defaults: Claude Code uses your account's default model. For Codex, crosscheck takes `model` and `model_reasoning_effort` from `~/.codex/config.toml`. Without them it uses your account's default Codex model, because the adapter's built-in default isn't available on every plan.

While it runs, a status line shows the round, the active agent, its phase, finding counts and elapsed time. Press **Ctrl-C** to cancel: agents are stopped and partial results are saved. Press it again to force quit.

### Outcomes

Every run ends with one of these outcomes, and each has its own exit code for scripting:

| Outcome | Meaning | Exit |
|---|---|---|
| `review_complete` | Both agents agree on every point, their last full review raised nothing material, and any checks that ran passed | 0 |
| `needs_input` | The agents agree on everything else, but some points need your decision: a product question, a dispute they couldn't settle after three exchanges, or a failed check | 2 |
| `budget_exhausted` | The round or time limit was reached | 3 |
| `stalled` | Two rounds in a row changed neither the plan nor any point | 4 |
| `error` | Authentication, agent, tool or output-validation failure | 1 |
| `cancelled` | You pressed Ctrl-C | 130 |

A round starts with a full review in fresh sessions when nothing is under discussion; otherwise it continues the discussion. In every round the author answers the reviewer's points, rules on its own disputed points, critiques the plan and revises it, and then the reviewer checks that turn. Thorough runs take several rounds, which is why the defaults are 8 rounds and 3 hours. If one agent reasons at a much lower effort than the other, crosscheck warns you: the weaker one tends to give in instead of arguing.

Agreement alone isn't proof: the report also lists checks that were skipped and assumptions the agents couldn't verify.

### Resuming a run

A run that stopped early can continue where it left off, with its points, plan versions and transcript intact:

```sh
crosscheck resume 20261027-140959-005a              # a run id from .crosscheck/runs
crosscheck resume .crosscheck/runs/20261027-140959-005a --rounds 4 --timeout 90
```

This works after `error`, `cancelled`, `budget_exhausted` or `stalled`, and after a crash. Both agents start fresh sessions and get the discussion so far from the points. If the run stopped in the middle of a round, it finishes that round first. `--rounds` sets how many more rounds to allow: by default the rounds the run had left, or 8 if it used them all. `--timeout` sets the time limit for the resumed session, by default the run's original limit. A run waiting for your decisions (`needs_input`) isn't resumed: run again from its plan with your decisions in `--constraints`, as its next steps show.

### What you get

Each run writes to `<repo>/.crosscheck/runs/<run-id>/`. That directory ignores itself, so it never shows up in `git status`.

```text
plan.md            the latest plan (every version is in plan/v0.md, v1.md, …)
report.md          outcome and why, what changed, settled and open points,
                   decisions for you, checks, assumptions, what was examined
findings.json      the ledger of points, with who raised each and how it was settled
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
- A Claude subscription login is handed to each session as it starts and isn't refreshed mid-turn. A rejected login costs a retried turn (see Setup for the long-lived token that avoids it).
- Linux and macOS only.

## Documentation

- [docs/design.md](docs/design.md): how the review loop, findings ledger and validation work, and what the integration spike established
- [docs/development.md](docs/development.md): running the tests, releasing, and upgrading the agent adapters
- [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE)
