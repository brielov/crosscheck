# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-10-27

### Changed

- The review is now a real discussion between the two agents, run until they agree on every point. Earlier versions did one review and then only checked the fixes, so a run could finish after a single pass with the author accepting everything.
  - **Both agents raise points.** Each turn, the author also critiques the plan and raises its own points, including problems the reviewer missed or earlier changes it now disagrees with. The reviewer must accept or dispute each one. Only the agent that raised a point can close it.
  - **Fresh full reviews.** Whenever nothing is under discussion, both agents start new sessions and re-read the whole plan. A run completes only when such a full review raises nothing material.
  - **Every point counts.** Low-severity points must be settled too instead of being listed as leftovers. A dispute goes to you after three maintained exchanges instead of two.
  - **Longer defaults:** 8 rounds and 3 hours (were 3 and 60 minutes). The guided setup offers 3–20 rounds and up to 8 hours.
  - `findings.json` records which agent raised each point and whose move it is. `authorResponse` is now `response`, with the answering agent in `actor`.
- crosscheck warns when one agent's reasoning effort is two or more levels below the other's, since the weaker one tends to give in instead of arguing.

## [0.2.1] - 2026-10-27

### Added

- Every run ends with numbered next steps, in the terminal and at the top of `report.md`, based on how the run ended. A finished review shows the commands to compare the revised plan with yours and to adopt it. A run waiting on your decisions gives a rerun command with a place to fill them in. Unfinished, failed and cancelled runs get a command that resumes from the latest plan. It also flags untested assumptions and leftover low-severity suggestions.

### Fixed

- The report names the branch of a repository with no commits yet, instead of showing `? @ no commits`.

## [0.2.0] - 2026-10-26

### Added

- Guided setup. Running `crosscheck` in a terminal asks for the input, author and reviewer models, effort, focus, constraints, verification commands and limits, choosing from real model lists. It suggests plan files and check commands found in the repository, shows the equivalent command line, and asks before starting. Flags fill in their answers, and `-i` asks for whatever is left even when a plan or brief is given.
- `crosscheck models [--json]` lists the models and effort levels each agent runtime accepts for your account.
- `crosscheck doctor` reports both model lists and checks the Codex default model and effort in `config.toml`.

### Changed

- Models and effort levels are checked against the runtimes before a run starts, with spelling suggestions. A mistyped model is a usage error (exit 64), or a choice in a terminal, instead of an agent failure minutes into the run.
- Without a model in `~/.codex/config.toml`, Codex uses your account's default model instead of the adapter's built-in one.

## [0.1.0] - 2026-10-26

### Added

- `crosscheck plan` reviews an existing Markdown plan, or drafts one from a brief, with an author agent and an independent reviewer agent (Claude Code and Codex through the AI SDK `HarnessAgent` adapters).
- Findings ledger with stable IDs, actor-gated statuses (only the reviewer can close a finding), disputes and decisions escalated to you.
- Explicit outcomes: `review_complete`, `needs_input`, `budget_exhausted`, `stalled`, `error`, `cancelled`, each with its own exit code.
- Interactive mode, `--focus`, `--constraints`, `--rounds`, `--timeout`, `--author`/`--reviewer` with models, `--effort`, `--check`, `--verbose`.
- Read-only, host-enforced repository tools for both agents; isolated agent runtime configuration.
- Per-run directory with plan versions, findings, transcript, events and a Markdown report, written incrementally.
- `crosscheck doctor` preflight checks.
- Standalone executables for Linux and macOS (x64, arm64) and a Homebrew tap.

[Unreleased]: https://github.com/brielov/crosscheck/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/brielov/crosscheck/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/brielov/crosscheck/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/brielov/crosscheck/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/brielov/crosscheck/releases/tag/v0.1.0
