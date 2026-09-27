// The system prompt, built by the host for every provider request from
// its inputs alone: identity, the local date and UTC offset, the
// session's cwd and model, and the AGENTS.md files from the nearest Git
// root down to the cwd (only the cwd's outside Git), most specific
// last. The
// same inputs give the same text, byte for byte, so prompt caching keeps
// working; changes during a session also reach the model as <meta>
// notes on the next prompt (replay.ts).

import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'

const identity = 'You are Hal, an assistant for coding and other work. You work in the current directory (cwd); relative paths are relative to it.'

// Local YYYY-MM-DD, weekday, UTC offset: the clock the [HH:MM] prompt
// stamps (replay.clock) use, named so the two can't be misread.
function date(now: number): string {
	let d = new Date(now)
	let two = (n: number) => String(n).padStart(2, '0')
	let weekday = d.toLocaleDateString('en-US', { weekday: 'long' })
	let off = -d.getTimezoneOffset()
	let zone = off ? `UTC${off < 0 ? '-' : '+'}${two(Math.floor(Math.abs(off) / 60))}:${two(Math.abs(off) % 60)}` : 'UTC'
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}, ${weekday}, ${zone}`
}

// Directories whose AGENTS.md (or CLAUDE.md) applies, outermost first:
// from the nearest ancestor with .git down to the cwd; outside Git, the
// cwd alone.
function candidates(cwd: string): string[] {
	let dirs: string[] = []
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		dirs.unshift(dir)
		if (existsSync(`${dir}/.git`)) return dirs
		if (dirname(dir) === dir) return [resolve(cwd)]
	}
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
	for (let dir of systemPrompt.candidates(input.cwd)) {
		// One file per directory: AGENTS.md, else CLAUDE.md.
		for (let name of ['AGENTS.md', 'CLAUDE.md']) {
			let path = `${dir === '/' ? '' : dir}/${name}`
			let text = read(path)
			if (text === undefined) continue
			parts.push(`<file path="${path}">\n${text.trim()}\n</file>`)
			break
		}
	}
	return parts.join('\n\n')
}

export const systemPrompt = {
	identity: () => identity,
	candidates,
	build,
}
