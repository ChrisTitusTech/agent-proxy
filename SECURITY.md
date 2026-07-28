# Security policy

## Supported versions

Until the first stable release, security fixes are applied to the current
`main` branch.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

[Open a private security advisory](https://github.com/ChrisTitusTech/agent-proxy/security/advisories/new).

Do not open a public issue for suspected vulnerabilities. Do not include real
API keys, provider credentials, prompt content, session files, or private logs
in a report. Use minimal sanitized reproduction data.

Include:

- The affected commit or version.
- The endpoint or provider involved.
- Reproduction steps and expected impact.
- Whether authentication is required.
- Suggested mitigations, if known.

## Security model

`agent-proxy` executes authenticated provider CLIs as the logged-in desktop
user. This intentionally grants provider tools the same filesystem access as
that user. Keep the listener on loopback, protect independent API and admin
tokens, use restrictive chat/tool profiles, and do not treat another local
process as trusted merely because it shares the same UID.

Built-in provider inference must run through the current user's Herdr session.
An unavailable Herdr runtime is an execution failure, not permission to launch
an invisible headless process.

The project does not consider provider quota bypass, account sharing, or
credential extraction to be supported use cases.
