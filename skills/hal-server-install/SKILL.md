---
name: hal-server-install
description: Set up Hal as a supervised server on another Linux machine over SSH — checkout, systemd, what to carry over from this Hal, login and a TLS proxy.
---

# Install Hal on a server

The target's own checkout holds the details: read its `SERVER.md` and
follow it. This skill adds what a remote setup must decide.

## Ask first

- Host, SSH user and the account Hal runs as (prefer an unprivileged one).
- Public name (e.g. `hal.example.com`) or SSH-tunnel only.
- Whether a Hal host already runs there: never start a second host for
  the same checkout; stopping one interrupts its work.

## Steps

1. Check SSH, `systemctl --user` (or NixOS), free disk and Bun.
2. Clone this checkout's origin (`git -C <hal home> remote get-url origin`)
   as the service account; run `./install -y`.
3. Carry over files (table below), then set `hostMode: 'server'`, a
   fixed `webPort`, and `webUrl` when public.
4. `./scripts/install-service --print`, then install; enable with
   `systemctl --user enable --now hal.service`; `loginctl enable-linger`.
   On NixOS give the user the snippet from `SERVER.md`; never hand-edit
   `/etc`.
5. Check `journalctl --user -u hal.service` for the actual port.
6. Proxy (below), then `./run auth` on the server for a login code.
7. The user runs `/login` there for providers.

## What to carry over

| File | Do |
|---|---|
| `USER.md` | Copy: the user's preferences apply everywhere. |
| `config.ason` | Copy, then adjust `hostMode`, `webPort`, `webUrl`. |
| `plugins/`, `local.ts` | Ask per item; they may assume this machine. |
| `secrets/` | **Never copy.** OAuth refresh on one host invalidates the other's token; each host logs in itself. |
| `sessions/`, `state/` | Never: per-machine history, locks, sockets, web tokens. |

Copy with `scp`/`rsync` over SSH, keeping files private (`chmod 600`).

## TLS proxy (Caddy)

Caddy gets and renews certificates itself once DNS points at the server
and ports 80/443 are open; `reverse_proxy` passes WebSockets through.

```
hal.example.com {
	reverse_proxy 127.0.0.1:9001
}
```

Use the port from the journal: Hal moves past a busy `webPort`. Append to
an existing Caddyfile, never replace it; `caddy validate` before
`systemctl reload caddy`. Keep Hal's port on loopback.

## Done means

`systemctl --user status hal.service` is active, the public URL shows
the login page, a code from `./run auth` logs in, and `/restart host`
brings the service back.
