# Hal on a Linux server

Hal runs from a **writable Git checkout**, including its configuration,
plugins, credentials and conversations. The service runs that checkout
with Bun; it does not copy Hal into an immutable package or build a
second installation. Use a dedicated, unprivileged account when Hal
should not have access to your other files. Hal's tools run with that
account's permissions; this is not a sandbox.

## Install a user service

Clone Hal under the account that will run it, then run `./install` in
that checkout. Bun and the checkout's dependencies must already exist.
The service installer captures the absolute checkout and Bun paths and
your current `PATH` (used by tools); systemd does not read shell startup
files. Keep these paths stable, or inspect and reinstall the unit after
moving them.

```sh
cd /path/to/hal
./scripts/install-service --print  # inspect the proposed unit
./scripts/install-service          # writes the user unit only
```

The installer never starts, enables or stops a process, changes
`config.ason`, grants linger, or overwrites a different existing unit.
It leaves activation to you so an existing interactive host is not
silently replaced.

Add this field to the checkout's existing `config.ason` object,
preserving its other settings:

```ason
hostMode: 'server',
```

The default `hostMode: 'auto'` lets a local client become host when no
host is available. Server mode makes local clients, including print
mode, wait for the supervised host instead. `hal serve` is the explicit
foreground host entry point; it does not attach a terminal or become a
client of another host. An existing host for the same home makes it
fail rather than starting a competing host. Local clients and the
service must use the same checkout/home and user.

Before stopping a legacy host, close or restart **all local Hal processes
running older code**. Already-running clients that predate server mode
ignore the new setting and can still take over; updating files alone
does not update those processes. With the new code and configuration in
place, `/restart all` can reload launcher-managed clients into waiting
mode. Review active work before any restart; the installer does not do
this for you.

When you are ready to migrate, deliberately stop the existing host
first. Quitting a peer is not stopping its host. Stopping a host can
interrupt active work; choose a suitable time. Do not enable the service
alongside an existing host and expect the installer to migrate it.
Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now hal.service
systemctl --user status hal.service
journalctl --user -u hal.service -f
```

For boot startup and operation after logout, enable linger for the
service account:

```sh
loginctl enable-linger "$USER"
```

This requires authorization on some systems; ask an administrator if
refused. A user manager must also be available for `systemctl --user`
(for example through a normal login). Running it through an arbitrary
`sudo -u` shell need not provide a user bus. Without linger the service
is tied to the user manager's login lifetime, not reliably to boot.

## Operate and edit

```sh
systemctl --user restart hal.service   # deliberately restart the host
systemctl --user stop hal.service      # stays stopped, even with clients open
systemctl --user disable hal.service   # remove future automatic startup
# After correcting repeated startup failures:
systemctl --user reset-failed hal.service
systemctl --user start hal.service
```

The unit runs **Bun directly**, not `./run`'s restart loop. systemd
restarts crashes and Hal's intentional exit code 100 (`/restart host`),
with a two-second delay and a startup failure limit. A clean exit does
not restart; an explicit systemd stop stays stopped. Server-mode peers
never take over a stopped service. `/restart both` or `/restart all`
also restarts the requesting terminal through its ordinary launcher.
Inspect journal output for full startup errors rather than repeatedly
restarting a broken service.

Edit the checkout as usual. Configuration and plugins retain their
normal live reload behavior; after the first request builds the web
page, web source changes trigger rebuilds and browser reloads. Other
host source changes require a host restart. Install changed dependencies
before restarting. Keep backups of the writable
home, especially `sessions/`, `secrets/`, configuration and private
plugins; Git is not a conversation or credential backup.

The service sets `WorkingDirectory` and `HAL_HOME` to the checkout, so
its initial session cwd and runtime state do not depend on systemd's
default directory. `HAL_HOME` also keeps temporary attachments beneath
the home. Logs go to the journal; private state stays in the checkout.

## Connect securely

On the server, `./run` attaches a local terminal; `./run auth` prints a
one-time web login code. Do not put login codes or provider credentials
in the unit or publish them. Use `/login` from a connected client to set
up provider accounts.

Hal's HTTP listener binds to loopback (`127.0.0.1`), by default on port
9001, trying nearby ports if occupied. Check the actual startup port
before configuring a proxy or tunnel. For private access, an SSH tunnel
can carry this loopback port to your computer. For public access, put a
TLS reverse proxy in front of it, forwarding WebSocket upgrades and the
normal HTTP routes, and set `webUrl: 'https://hal.example.com'` in
`config.ason`. Keep the backend loopback-only; expose only the intended
TLS endpoint, not Hal's Unix socket or writable home. `webUrl` supplies
public links, not TLS or a network access policy. The browser uses the
one-time code to log in; the remote terminal connects with
`./run -r https://hal.example.com`. Diagnostics remain off unless you
explicitly enable them.

## NixOS: declarative system service, writable checkout

For a system service managed by NixOS, use an existing service account
and a checkout it owns outside the Nix store. Do not also enable the
user unit for that same home. Substitute your own generic paths/account:

```nix
{ pkgs, ... }: {
  users.users.hal = {
    isSystemUser = true;
    group = "hal";
    home = "/var/lib/hal";
    createHome = true;
  };
  users.groups.hal = {};

  systemd.services.hal = {
    description = "Hal live-checkout host";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    # Add runtimes and tools needed by your sessions to this PATH.
    path = [ pkgs.bun pkgs.bash pkgs.git pkgs.coreutils ];
    environment.HAL_HOME = "/var/lib/hal/checkout";
    unitConfig = {
      StartLimitIntervalSec = 60;
      StartLimitBurst = 5;
    };
    serviceConfig = {
      User = "hal";
      Group = "hal";
      WorkingDirectory = "/var/lib/hal/checkout";
      ExecStart = "${pkgs.bun}/bin/bun /var/lib/hal/checkout/src/main.ts serve";
      Restart = "on-failure";
      RestartForceExitStatus = [ 100 ];
      RestartSec = 2;
      KillMode = "control-group";
      TimeoutStopSec = 30;
      UMask = "0077";
    };
  };
}
```

Provision the checkout and dependencies as that account, set
`hostMode: 'server'`, and resolve any existing host before activating
the service. NixOS owns the unit and Bun runtime; the checkout remains
editable, including by Hal. Dependency installation can use
`bun install` in the checkout without running `./install`'s shell/link
setup. For this unit use `systemctl status|restart|stop hal.service`
and `journalctl -u hal.service` without `--user`; linger is unnecessary.
No immutable-store protection or restrictive filesystem sandbox is
claimed: Hal needs write access wherever you intend its tools to work.
