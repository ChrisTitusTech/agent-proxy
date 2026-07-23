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

agent-proxy executes authenticated provider CLIs as child processes. Operators
must run it as a dedicated non-root user, protect API and admin tokens, restrict
network exposure, and use TLS through a trusted reverse proxy.

The project does not consider provider quota bypass, account sharing, or
credential extraction to be supported use cases.
