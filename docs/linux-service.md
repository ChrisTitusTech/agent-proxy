# Linux service operations

This runbook covers the supported Phase 1 deployment: a versioned release
under `/opt`, operator configuration under `/etc`, persistent state under
`/var/lib`, and a dedicated `agent-proxy` systemd account.

## Prerequisites

- A current systemd-based Linux distribution.
- Node.js 24 or newer.
- `npm`, `tar`, `curl`, `openssl`, `sudo`, and standard account-management
  tools.
- At least one supported CLI installed and authenticated for the
  `agent-proxy` account before that provider is enabled.

The production template disables every provider. This lets the service pass
its initial health check before provider credentials are configured.

## Build a release

Build from a trusted, clean checkout:

```bash
scripts/build-release.sh
```

The command runs `npm ci`, compiles the workspaces, and writes a versioned
archive under `dist/releases/`. The archive contains compiled server code,
production runtime dependencies, systemd assets, and a `VERSION` manifest.

## Install

```bash
sudo scripts/install.sh install \
  --archive dist/releases/agent-proxy-VERSION-linux-ARCH.tar.gz
```

The installer:

- creates the system user and group `agent-proxy`;
- installs an immutable release under `/opt/agent-proxy/releases`;
- points `/opt/agent-proxy/current` at that release;
- creates `/etc/agent-proxy`, `/var/lib/agent-proxy`, and
  `/var/log/agent-proxy`;
- installs and enables `agent-proxy.service` without starting it.

Edit the generated secrets before starting a production listener:

```bash
sudoedit /etc/agent-proxy/agent-proxy.env
sudoedit /etc/agent-proxy/config.yaml
sudo systemctl start agent-proxy
```

The startup preflight rejects the placeholder credentials shipped in the
environment template.

Generate independent credentials:

```bash
openssl rand -hex 32
printf 'sk-proxy-%s\n' "$(openssl rand -hex 24)"
```

## Authenticate a provider

Use a shell owned by the service account so the CLI stores credentials under
the same home directory used by systemd:

```bash
sudo -u agent-proxy -H env HOME=/var/lib/agent-proxy codex login
sudo -u agent-proxy -H env HOME=/var/lib/agent-proxy grok login
```

Use the equivalent supported login command for Claude Code or Google
Antigravity. Add the CLI directory to `PATH` in
`/etc/agent-proxy/agent-proxy.env`, enable only that provider in
`config.yaml`, and run the preflight through a transient systemd service. The
system manager can read the root-owned environment file before dropping to the
service account:

```bash
sudo systemd-run --wait --pipe --collect \
  --unit=agent-proxy-preflight \
  --property=User=agent-proxy \
  --property=Group=agent-proxy \
  --property=WorkingDirectory=/var/lib/agent-proxy \
  --property=EnvironmentFile=/etc/agent-proxy/agent-proxy.env \
  /usr/bin/node \
  /opt/agent-proxy/current/packages/server/dist/index.js --check
```

Do not place credentials in the unit file or repository.

## Operate and verify

```bash
sudo systemctl start agent-proxy
sudo systemctl stop agent-proxy
sudo systemctl restart agent-proxy
sudo systemctl status agent-proxy
sudo journalctl -u agent-proxy
curl --fail http://127.0.0.1:8300/health
```

The service listens on loopback by default. Put a TLS reverse proxy and
firewall policy in front of it before allowing remote traffic.

## Upgrade

Build or obtain the new release archive, then run:

```bash
sudo scripts/install.sh upgrade --archive NEW_RELEASE.tar.gz
timeout 30s sh -c \
  'until curl --fail http://127.0.0.1:8300/health; do sleep 1; done'
```

Upgrade records whether the service is running, stops it, creates a
configuration and SQLite backup, installs the new version beside the old one,
and atomically changes `current`. It restarts the service only if it was
running before the upgrade. Configuration, API keys, model mappings, and
SQLite data are outside the release directory.

## Roll back

```bash
sudo scripts/install.sh rollback
timeout 30s sh -c \
  'until curl --fail http://127.0.0.1:8300/health; do sleep 1; done'
```

Rollback swaps the `current` and `previous` release links. If a schema or data
change also needs reversal, restore the pre-upgrade backup before starting the
old release.

## Backup and restore

Create a consistent offline backup:

```bash
sudo scripts/install.sh backup
```

Backups are written to `/var/backups/agent-proxy`. The command briefly stops
an active service, archives `/etc/agent-proxy` and `/var/lib/agent-proxy`,
then restores its prior active or inactive state.

Restore while the service is stopped:

```bash
sudo systemctl stop agent-proxy
sudo tar -C / -xzf /var/backups/agent-proxy/agent-proxy-backup-TIMESTAMP.tar.gz
sudo chown -R root:agent-proxy /etc/agent-proxy
sudo chown -R agent-proxy:agent-proxy /var/lib/agent-proxy
sudo systemctl start agent-proxy
```

## Shutdown behavior

On `SIGTERM`, the server stops accepting new connections and waits up to
`SHUTDOWN_TIMEOUT_MS` for active requests. It then stops persistent provider
workers, terminates tracked child processes with `SIGTERM` and a bounded
`SIGKILL` fallback, closes SQLite, and exits. systemd applies an outer
45-second stop limit and kills any remaining process in the service cgroup.

## systemd security review

Review the shipped unit on the target distribution:

```bash
systemd-analyze verify /etc/systemd/system/agent-proxy.service
systemd-analyze security agent-proxy.service
```

The unit deliberately enables:

- a dedicated non-root account and restrictive `UMask`;
- an empty capability and ambient-capability set;
- `NoNewPrivileges`;
- read-only system paths with explicit writable state, log, and runtime paths;
- private devices and temporary storage;
- kernel, hostname, namespace, realtime, and set-user-ID restrictions;
- address-family and native-system-call-architecture restrictions.

`MemoryDenyWriteExecute` is not enabled because the Node.js runtime uses
just-in-time compilation. Network access remains enabled because every
provider and API listener requires it. The service account state directory is
writable because authenticated CLIs store session data there. Re-run the
review after changing CLI modes or filesystem paths.

On systemd 259, the shipped unit reports an exposure score of `2.8 OK`. The
remaining findings are reviewed exceptions: no chroot is used because releases
are versioned and system paths are read-only; writable executable memory is
required by Node.js; local and Internet sockets are required by the API and
providers; and additional syscall filtering is deferred until all four CLI
modes have a tested common syscall profile.

## Uninstall

Preserve configuration and state:

```bash
sudo scripts/install.sh uninstall
```

Permanently remove configuration, state, logs, and backups only with explicit
approval:

```bash
sudo scripts/install.sh uninstall --purge
```

Normal uninstall preserves backups under `/var/backups/agent-proxy`;
`--purge` removes them.
