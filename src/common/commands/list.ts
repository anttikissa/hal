// Every slash command, whoever runs it (tasks/w4/forms.md, Keys and
// client-only commands): the one list /keys, /help, completion and the
// key dispatchers read. The host runs a command from its file in
// src/host/commands/<name>.ts; a `clientOnly` one runs in the client
// from src/client/commands/<name>.ts and never reaches the host.
// `key`: a label as common/key-help.ts writes them; pressing it runs the
// command with no arguments, as if `/<name>` were typed and sent,
// except the tab keys, which act unrecorded (client/commands.ts).

import { keyHelp, type Binding } from '../key-help.ts'

// `keyArgs`: the arguments the key runs the command with, as /keys shows.
// `defaultArgs`: Tab fills these for an exact command without arguments.
export type CommandInfo = { name: string; description: string; category: string; key?: string; keyArgs?: string; defaultArgs?: string; clientOnly?: true; hidden?: true }

// Sorted by name.
const list: CommandInfo[] = [
	{ name: 'auth', description: 'one-time code for the web client', category: 'session' },
	{ name: 'branch', description: 'alias for /fork', category: 'tabs', hidden: true },
	{ name: 'budget', description: 'show or set spawn slots', category: 'session' },
	{ name: 'cd', description: 'change the working directory', category: 'session' },
	{ name: 'changes', description: 'list observed file changes and diffs, or clear the list', category: 'session' },
	{ name: 'clear', description: 'start a fresh context in this tab', category: 'session' },
	{ name: 'clients', description: 'show who is connected to the host', category: 'debug' },
	{ name: 'close', description: 'close the tab', category: 'tabs', key: 'ctrl-w' },
	{ name: 'compact', description: 'summarize the context so far', category: 'session' },
	{ name: 'config', description: 'show or change settings', category: 'app' },
	{ name: 'effort', description: 'set the model\'s effort', category: 'session' },
	{ name: 'find', description: 'search all sessions', category: 'session', key: 'ctrl-f' },
	{ name: 'fork', description: 'fork this session into a new tab', category: 'tabs', key: 'ctrl-b' },
	{ name: 'go', description: 'go to a session, reopening it if closed', category: 'tabs' },
	{ name: 'help', description: 'list commands, or show one in detail', category: 'help' },
	{ name: 'history', description: 'show this session’s history file path', category: 'session' },
	{ name: 'intro', description: 'run the first-run guide again', category: 'help' },
	{ name: 'keys', description: 'list the keys', category: 'help', key: 'f1' },
	{ name: 'kill', description: 'stop a background job', category: 'session' },
	{ name: 'login', description: 'log in to a provider', category: 'session' },
	{ name: 'logout', description: 'revoke a web login or all web logins', category: 'app' },
	{ name: 'mem', description: 'show host memory use', category: 'debug' },
	{ name: 'model', description: 'pick the model', category: 'session', key: 'ctrl-m' },
	{ name: 'move', description: 'move this tab to a numbered position', category: 'tabs' },
	{ name: 'new', description: 'new tab', category: 'tabs', key: 'ctrl-t' },
	{ name: 'notifications', description: 'list past notifications', category: 'session' },
	{ name: 'pause', description: 'pause the turn', category: 'session' },
	{ name: 'perf', description: 'show startup timing marks', category: 'debug' },
	{ name: 'plugins', description: 'list loaded plugins and their hooks', category: 'debug' },
	{ name: 'queue', description: 'list, run, drop or clear queued messages', category: 'session' },
	// Ctrl-C, Ctrl-Z and Ctrl-R are really caught by the emergency path:
	// src/common/emergency.ts scans raw stdin and src/client/terminal.ts
	// acts on them before any key decoding (tasks/README.md). Changing
	// these three `key`s changes only what /keys shows, not the keys.
	{ name: 'quit', description: 'quit', category: 'app', key: 'ctrl-c', clientOnly: true },
	{ name: 'recap', description: 'recall session goals, progress and blockers', category: 'session' },
	{ name: 'rebase', description: 'rewrite session history, or undo the last rewrite', category: 'session' },
	{ name: 'redraw', description: 'redraw', category: 'app', key: 'ctrl-l' },
	{ name: 'rename', description: 'name or clear the session name', category: 'session' },
	// /restart local (Ctrl-R) runs in the client; bare (all), host and both
	// on the host (src/host/commands/restart.ts).
	{ name: 'restart', description: 'restart everything (all), the host, both, or this client (local)', category: 'app', key: 'ctrl-r', keyArgs: 'local', defaultArgs: 'all' },
	{ name: 'resume', description: 'reopen a closed session', category: 'tabs', key: 'shift-ctrl-t' },
	{ name: 'send', description: 'send a message or command to another session', category: 'session' },
	{ name: 'suspend', description: 'suspend', category: 'app', key: 'ctrl-z', clientOnly: true },
	{ name: 'status', description: 'show account usage windows', category: 'session' },
	{ name: 'system', description: 'show the assembled system prompt', category: 'session' },
	{ name: 'tabs', description: 'list open tabs or all saved sessions', category: 'tabs' },
	{ name: 'theme', description: 'list or switch the color theme', category: 'app' },
	{ name: 'toggle', description: 'open or close blocks', category: 'session', key: 'ctrl-o' },
	{ name: 'todo', description: 'file or list project TODO items', category: 'session' },
	{ name: 'version', description: 'show which code the host runs', category: 'debug' },
]

// Keys a browser keeps for itself except on macOS, where they are Cmd.
const browserKeys = ['ctrl-t', 'shift-ctrl-t', 'ctrl-w', 'ctrl-n', 'ctrl-p']

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
