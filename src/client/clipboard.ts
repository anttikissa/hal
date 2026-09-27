// The system clipboard's text, for Cmd-C, Cmd-X and Ctrl-V, and its
// image for Ctrl-V (task zc). Writes go
// to pbcopy on macOS and wl-copy or xclip on Linux; over SSH (SSH_TTY
// set) they go as OSC 52 to the terminal instead, which puts them on
// the user's own machine. Reads use pbpaste, wl-paste or xclip, and
// spawn only when asked (never at startup). Neither ever throws: a
// missing tool or a failure comes back as a notice for the prompt.

import { terminal } from './terminal.ts'

type Env = { platform: string; ssh: boolean; wayland: boolean }

function env(): Env {
	let e = process.env
	return { platform: process.platform, ssh: !!e.SSH_TTY, wayland: !!e.WAYLAND_DISPLAY || e.XDG_SESSION_TYPE === 'wayland' }
}

// Commands to try, in order; the first that runs wins.
function writers(e: Env): string[][] {
	if (e.platform === 'darwin') return [['pbcopy']]
	if (e.platform !== 'linux') return []
	let x = ['xclip', '-selection', 'clipboard']
	return e.wayland ? [['wl-copy'], x] : [x, ['wl-copy']]
}

function readers(e: Env): string[][] {
	if (e.platform === 'darwin') return [['pbpaste']]
	if (e.platform !== 'linux') return []
	let x = ['xclip', '-selection', 'clipboard', '-o']
	let w = ['wl-paste', '--no-newline']
	return e.wayland ? [w, x] : [x, w]
}

// Runs `cmd` with `input` on stdin; its stdout, or null if it could not
// run or failed.
async function run(cmd: string[], input?: string): Promise<string | null> {
	let out = await clipboard.exec(cmd, input)
	return out && new TextDecoder().decode(out)
}

async function exec(cmd: string[], input?: string): Promise<Uint8Array | null> {
	try {
		let p = Bun.spawn(cmd, { stdin: input === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'ignore' })
		if (input !== undefined) {
			let stdin = p.stdin as import('bun').FileSink
			stdin.write(input)
			await stdin.end()
		}
		let out = new Uint8Array(await new Response(p.stdout).arrayBuffer())
		return (await p.exited) === 0 ? out : null
	} catch {
		return null
	}
}

function osc52(text: string): string {
	return `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`
}

const missing = (what: string) => `no clipboard tool to ${what} (install ${process.platform === 'darwin' ? 'pbcopy' : 'wl-clipboard or xclip'})`

/** Puts `text` on the clipboard; a notice if it could not. */
async function write(text: string): Promise<string | undefined> {
	let e = clipboard.env()
	if (e.ssh) {
		terminal.state.io?.write(clipboard.osc52(text))
		return undefined
	}
	for (let cmd of clipboard.writers(e)) if ((await clipboard.run(cmd, text)) !== null) return undefined
	return missing('copy')
}

/** The clipboard's text, or a notice if it could not be read. */
async function read(): Promise<{ text: string } | { notice: string }> {
	for (let cmd of clipboard.readers(clipboard.env())) {
		let text = await clipboard.run(cmd)
		if (text !== null) return { text }
	}
	return { notice: missing('paste') }
}

// A PNG image on the clipboard, or null: NSPasteboard on macOS
// (pasteboard.ts), wl-paste or xclip on Linux.
async function image(): Promise<Uint8Array | null> {
	let e = clipboard.env()
	if (e.platform === 'darwin') return (await import('./pasteboard.ts')).pasteboard.png()
	if (e.platform !== 'linux') return null
	let x = ['xclip', '-selection', 'clipboard', '-t', 'image/png', '-o']
	let w = ['wl-paste', '--type', 'image/png']
	for (let cmd of e.wayland ? [w, x] : [x, w]) {
		let out = await clipboard.exec(cmd)
		if (out?.length) return out
	}
	return null
}

export const clipboard = { env, writers, readers, run, exec, osc52, write, read, image }
