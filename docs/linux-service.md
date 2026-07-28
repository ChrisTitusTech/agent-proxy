# Current-user Linux service

`agent-proxy` is installed and run as the logged-in desktop user. It does not
create a Unix account, write machine-wide configuration, or require root for
install, upgrade, rollback, backup, or uninstall.

## Layout

| Purpose | Location |
| --- | --- |
| Configuration | `${XDG_CONFIG_HOME:-$HOME/.config}/agent-proxy` |
| Releases | `${XDG_DATA_HOME:-$HOME/.local/share}/agent-proxy` |
| Database, logs, backups | `${XDG_STATE_HOME:-$HOME/.local/state}/agent-proxy` |
| Runtime jobs | `${XDG_RUNTIME_DIR}/agent-proxy` |
| User units | `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user` |

All provider CLIs and credentials remain in the user's normal home and XDG
directories. Authenticate each enabled CLI normally as that user.

## Install and lifecycle

Build or download a release archive, then run:

```bash
scripts/install.sh install --archive dist/releases/agent-proxy-VERSION-linux-ARCH.tar.gz
systemctl --user status herdr.service agent-proxy.service
```

The installer generates owner-only API credentials, installs both user units,
and enables them for `default.target`. `agent-proxy.service` orders itself
after `herdr.service`; inference fails closed with `503` if Herdr is not ready.
The user service creates `${XDG_RUNTIME_DIR}/agent-proxy` with
`RuntimeDirectory=agent-proxy` and owner-only permissions before preflight.

Lifecycle commands use the same installer:

```bash
scripts/install.sh upgrade --archive NEW_RELEASE.tar.gz
scripts/install.sh backup
scripts/install.sh rollback
scripts/install.sh uninstall
scripts/install.sh uninstall --purge
```

Uninstall preserves configuration and operational state unless `--purge` is
specified. Provider-owned credentials and CLI state are never removed.
Backup and upgrade stop an active proxy before snapshotting the SQLite WAL
state, then restore the prior active state. Existing backup archives are
excluded from later snapshots.

## Configuration

Edit:

```bash
${EDITOR:-vi} "${XDG_CONFIG_HOME:-$HOME/.config}/agent-proxy/config.yaml"
systemctl --user restart agent-proxy.service
```

Enable only CLIs already installed and authenticated for the logged-in user.
All CLI-provider inference launches inside a Herdr-managed pane. Health, model
discovery, and admin requests do not create agents.

The unauthenticated liveness endpoint returns only `{"status":"ok"}`.
Authenticated operational readiness is available at `/admin/health`.

## Validation

```bash
scripts/test-user-install.sh
scripts/test-user-service.sh
scripts/test-herdr-launcher.sh
```
