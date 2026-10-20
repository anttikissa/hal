---
name: hal-server-install
description: Set up or update Hal on a Linux server over SSH, with HTTPS through Caddy and a systemd user service. Use when the user asks to set up, install or update Hal on a server.
---

# Install Hal on a server

Run in the foreground, from Hal's home, with no questions first:

    scripts/server-setup <ssh-host> [public-name]

`<ssh-host>` is what `ssh` takes (`user@host` for another account). The
public name defaults to the host. The script needs nothing else: it
checks SSH, DNS and root, sends the committed checkout and the user's
files, and is safe to rerun.

If it fails, show its reason and ask the user for what it needs (SSH
access, passwordless sudo, DNS, open ports), then rerun.

If the user wants something other than Caddy and systemd, discuss it
with them before changing or replacing the script; `SERVER.md` beside
this file covers manual and NixOS setups.

## When it succeeds

Reply with this, filled from the script's last lines: the first code for
the browser, the second for `hal -r`, the third for the phone. Add its
`Hint:` line, if any, at the end.

    Hal is running at <public-name>
    Use the following URL to log in with your browser:

    	https://<public-name>/?auth=<code 1>

    Use the `hal -r` remote client with:

    	hal -r <public-name>
    	# When connected, use code: <code 2>

    Here's one more authentication code for your phone: <code 3>

    Codes work one time each and are valid for 10 minutes.
    Use `/auth` or `hal auth` to get more, and `/clients` to see connected
    clients; `/logout <id>` revokes a login.
