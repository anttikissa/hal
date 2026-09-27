// The system prompt, built by the host for every provider request from
// its inputs alone: identity, the local date, the session's cwd and
// model, and the AGENTS.md files from the filesystem root down to the
// cwd, most specific last. The
// same inputs give the same text, byte for byte, so prompt caching keeps
// working; changes during a session also reach the model as <meta>
// notes on the next prompt (replay.ts).

import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'

const identity = 'You are Hal, an assistant for coding and other work. You work in the current directory (cwd); relative paths are relative to it.'

// Local YYYY-MM-DD, weekday.
function date(now: number): string {
	let d = new Date(now)
	let two = (n: number) => String(n).padStart(2, '0')
	let weekday = d.toLocaleDateString('en-US', { weekday: 'long' })
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}, ${weekday}`
}

// AGENTS.md paths that may apply, outermost first, each once.
function candidates(cwd: string): string[] {
	let dirs: string[] = []
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		dirs.unshift(dir)
		if (dirname(dir) === dir) break
	}
	return dirs.map((d) => `${d === '/' ? '' : d}/AGENTS.md`)
}

function read(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		return undefined
	}
}

function build(input: { cwd: string; model: string; now: number }): string {
	let parts = [systemPrompt.identity(), `<date>${date(input.now)}</date>\n<cwd>${input.cwd}</cwd>\n<model>${input.model}</model>`]
	for (let path of systemPrompt.candidates(input.cwd)) {
		let text = read(path)
		if (text !== undefined) parts.push(`<file path="${path}">\n${text.trim()}\n</file>`)
	}
	return parts.join('\n\n')
}

export const systemPrompt = {
	identity: () => identity,
	candidates,
	build,
}
