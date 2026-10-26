# Security policy

crosscheck runs coding agents against your repository, so its permission model matters. The design is described under [Permissions and safety](README.md#permissions-and-safety).

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/brielov/crosscheck/security/advisories/new), not in public issues. Useful reports include a way for an agent to read or modify something the tool policy should block (files outside the repository, secrets, `.git/`, `.crosscheck/`), to execute commands beyond the permitted `--check` list, or to leak credentials into run artifacts.

Only the latest release receives fixes.
