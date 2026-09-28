// Every slash command, whoever runs it (tasks/w4/forms.md, Keys and
// client-only commands): the one list /keys, /help, completion and the
// key dispatchers read. The host runs a command from its file in
// src/host/commands/<name>.ts; a `clientOnly` one runs in the client
// from src/client/commands/<name>.ts and never reaches the host.
// `key`: a label as common/key-help.ts writes them; pressing it runs the
// command with no arguments, as if `/<name>` were typed and sent.

import { keyHelp, type Binding } from '../key-help.ts'

export type CommandInfo = { name: string; description: string; category: string; key?: string; clientOnly?: true }

// Sorted by name.
const list: CommandInfo[] = [
	{ name: 'auth', description: 'one-time code for the web client', category: 'session' },
	{ name: 'cd', description: 'change the working directory', category: 'session' },
	{ name: 'close', description: 'close the tab', category: 'tabs', key: 'ctrl-w', clientOnly: true },
	{ name: 'compact', description: 'summarise the context so far', category: 'session' },
	{ name: 'help', description: 'list commands, or show one in detail', category: 'help' },
	{ name: 'keys', description: 'list the keys', category: 'help', key: 'f1' },
	{ name: 'login', description: 'log in to a provider', category: 'session' },
	{ name: 'model', description: 'pick the model', category: 'session', key: 'ctrl-m' },
	{ name: 'new', description: 'new tab', category: 'tabs', key: 'ctrl-t', clientOnly: true },
	{ name: 'pause', description: 'pause the turn', category: 'session' },
	{ name: 'perf', description: 'show startup timing marks', category: 'debug' },
	// Ctrl-C, Ctrl-Z and Ctrl-R are really caught by the emergency path:
	// src/client/emergency.ts scans raw stdin and src/client/terminal.ts
	// acts on them before any key decoding (tasks/README.md). Changing
	// these three `key`s changes only what /keys shows, not the keys.
	{ name: 'quit', description: 'quit', category: 'app', key: 'ctrl-c', clientOnly: true },
	{ name: 'redraw', description: 'redraw', category: 'app', key: 'ctrl-l', clientOnly: true },
	{ name: 'rename', description: 'name or clear the session name', category: 'session' },
	{ name: 'restart', description: 'restart', category: 'app', key: 'ctrl-r', clientOnly: true },
	{ name: 'resume', description: 'reopen the last closed tab', category: 'tabs', key: 'shift-ctrl-t', clientOnly: true },
	{ name: 'suspend', description: 'suspend', category: 'app', key: 'ctrl-z', clientOnly: true },
	{ name: 'version', description: 'show which code the host runs', category: 'debug' },
]

// Keys a browser keeps for itself except on macOS, where they are Cmd.
const browserKeys = ['ctrl-t', 'shift-ctrl-t', 'ctrl-w', 'ctrl-n']

function all(): CommandInfo[] {
	return list
}

function byName(name: string): CommandInfo | undefined {
	return commandList.all().find((c) => c.name === name)
}

// The command pressing `k` runs, if any.
function byKey(k: Binding): CommandInfo | undefined {
	let same = (b: Binding) => b.key === k.key && b.shift === k.shift && b.alt === k.alt && b.ctrl === k.ctrl && b.cmd === k.cmd
	return commandList.all().find((c) => c.key !== undefined && same(keyHelp.parse(c.key)))
}

// Whether the browser gives key `label` to the page.
function onWeb(label: string, mac: boolean): boolean {
	return mac || !browserKeys.includes(label)
}

export const commandList = { all, byName, byKey, onWeb }
