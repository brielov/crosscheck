# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/brielov/crosscheck/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/brielov/crosscheck/releases/tag/v0.1.0
