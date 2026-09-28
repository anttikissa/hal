// The system prompt, built by the host for every provider request from
// its inputs alone: SYSTEM.md at the checkout root (who Hal is and its
// rules, edited by the user, read per request so an edit applies on the
// next one), the local date and UTC offset, the
// session's cwd and model, and the AGENTS.md files from the nearest Git
// root down to the cwd (only the cwd's outside Git), most specific
// last. The
// same inputs give the same text, byte for byte, so prompt caching keeps
// working; changes during a session also reach the model as <meta>
// notes on the next prompt (replay.ts).

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import { paths } from './paths.ts'

const systemFile = resolve(import.meta.dir, '../../SYSTEM.md')

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

// SYSTEM.md alone is a template; project instructions remain verbatim.
export type PromptSource = { path: string; bytes: number }
function preprocess(file: string, vars: Record<string, string>, stack: string[] = [], sources?: PromptSource[]): string {
	let path = resolve(file)
	if (stack.includes(path)) throw new Error(`${path}: include loop (${[...stack, path].join(' -> ')})`)
	let raw = readFileSync(path, 'utf8')
	sources?.push({ path, bytes: Buffer.byteLength(raw) })
	let text = raw.replace(/<!--[\s\S]*?-->/g, '')
	let lines = text.split('\n'), output: string[] = []
	let active: boolean | undefined
	let opened = 0
	let substitute = (s: string) => s.replace(/\$\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole)
	for (let [index, line] of lines.entries()) {
		let start = line.match(/^:{3,}\s+if\s+(.+?)\s*$/)
		if (start) {
			if (active !== undefined) throw new Error(`${path}:${index + 1}: nested if block`)
			let pairs = [...start[1]!.matchAll(/(\w+)="([^"]*)"/g)]
			if (!pairs.length || start[1]!.replace(/(\w+)="[^"]*"/g, '').trim()) throw new Error(`${path}:${index + 1}: invalid if directive`)
			active = pairs.map(([, key, pattern]) => {
				if (!Object.hasOwn(vars, key!)) throw new Error(`${path}:${index + 1}: unknown key ${key}`)
				let regex = new RegExp(`^${pattern!.replace(/[\\^$+.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
				return regex.test(vars[key!]!)
			}).every(Boolean)
			opened = index + 1
			continue
		}
		if (/^:{3,}\s*$/.test(line)) {
			if (active === undefined) throw new Error(`${path}:${index + 1}: unexpected closing directive`)
			active = undefined
			continue
		}
		if (active === false) continue
		let include = line.match(/^@(\??)(\S+)\s*$/)
		if (include) {
			let name = substitute(include[2]!)
			if (name.startsWith('~/')) name = resolve(homedir(), name.slice(2))
			let target = resolve(dirname(path), name)
			if (include[1] && !existsSync(target)) continue
			output.push(systemPrompt.preprocess(target, vars, [...stack, path], sources))
		} else output.push(line)
	}
	if (active !== undefined) throw new Error(`${path}:${opened}: unclosed if block`)
	return substitute(output.join('\n'))
}

function assemble(input: { cwd: string; model: string; now: number; sessionId?: string }, sources?: PromptSource[]): string {
	let fromSource = relative(paths.repoRoot(), resolve(input.cwd))
	let vars = {
		harness: 'hal', model: input.model, date: date(input.now), cwd: paths.display(input.cwd),
		hal_dir: paths.display(paths.repoRoot()), home: paths.home(),
		session_dir: input.sessionId ? paths.display(paths.sessionDir(input.sessionId)) : '',
		hal_source: fromSource !== '..' && !fromSource.startsWith(`..${sep}`) && !isAbsolute(fromSource) ? 'true' : 'false',
	}
	// Missing SYSTEM.md is a broken checkout: throw with the path.
	let parts = [systemPrompt.preprocess(systemPrompt.file(), vars, [], sources).trim(), `<date>${date(input.now)}</date>\n<cwd>${input.cwd}</cwd>\n<model>${input.model}</model>`]
	for (let dir of systemPrompt.candidates(input.cwd)) {
		// One file per directory: AGENTS.md, else CLAUDE.md.
		for (let name of ['AGENTS.md', 'CLAUDE.md']) {
			let path = `${dir === '/' ? '' : dir}/${name}`
			let text = read(path)
			if (text === undefined) continue
			sources?.push({ path, bytes: Buffer.byteLength(text) })
			parts.push(`<file path="${path}">\n${text.trim()}\n</file>`)
			break
		}
	}
	return parts.join('\n\n')
}

// One assembly path for /system and actual provider requests, so the
// displayed text cannot diverge from what the next request would send.
export type PromptInput = { cwd: string; model: string; now: number; sessionId?: string }
function build(input: PromptInput): string {
	return systemPrompt.assemble(input)
}
function inspect(input: PromptInput): { sources: PromptSource[]; text: string } {
	let sources: PromptSource[] = []
	return { sources, text: systemPrompt.assemble(input, sources) }
}

export const systemPrompt = {
	file: () => systemFile,
	preprocess,
	candidates,
	assemble,
	inspect,
	build,
}
