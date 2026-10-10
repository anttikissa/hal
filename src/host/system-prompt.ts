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

import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import { settings } from '../common/settings.ts'
import { actions } from './actions.ts'
import { paths } from './paths.ts'

const systemFile = resolve(import.meta.dir, '../../SYSTEM.md')

// Local YYYY-MM-DD, weekday, UTC offset: the clock the [HH:MM] prompt
// stamps (replay.clock) use, named so the two can't be misread.
function date(now: number): string {
	let d = new Date(now)
	let two = (n: number) => String(n).padStart(2, '0')
	// Not toLocaleDateString: building its formatter costs ~0.3 ms a call.
	let weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()]
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

// Skills (task 074): names only, so many skills cost few tokens; the
// model reads <dir>/SKILL.md when one fits. One line, a brace group per
// folder: /a/skills/{x,y} /b/skills/z.
// TODO: maybe an option to also list each skill's front matter
// description, so models pick skills better; names suffice for now. Hal's own skills/
// apply everywhere, like SYSTEM.md; a project's .agents/skills (or
// .claude/skills) only where its AGENTS.md would. Only folders holding a
// SKILL.md count; names are sorted so the text stays cache-stable.
function skills(cwd: string): string {
	let dirs = [`${paths.repoRoot()}/skills`]
	for (let dir of candidates(cwd)) for (let sub of ['.agents/skills', '.claude/skills']) dirs.push(`${dir === '/' ? '' : dir}/${sub}`)
	let groups: string[] = []
	for (let dir of new Set(dirs)) {
		let names: string[] = []
		try {
			names = readdirSync(dir).filter((name) => existsSync(`${dir}/${name}/SKILL.md`)).sort()
		} catch {}
		if (names.length) groups.push(names.length === 1 ? `${dir}/${names[0]}` : `${dir}/{${names.join(',')}}`)
	}
	return groups.length ? `Skills - read <dir>/SKILL.md when appropriate: ${groups.join(' ')}` : ''
}

function read(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		return undefined
	}
}

// HTML comments are notes for humans: stripped from every prompt file.
const uncomment = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '')

// SYSTEM.md alone is a template (if blocks, variables, includes); the
// files it includes and AGENTS.md only lose their comments. A broken
// template never fails a request: each fault goes to problems (file and
// line) and preprocessing carries on with the rest of the text.
export type PromptSource = { path: string; bytes: number }
function preprocess(file: string, vars: Record<string, string>, sources?: PromptSource[], problems: string[] = []): string {
	let path = resolve(file)
	let raw: string
	try {
		raw = readFileSync(path, 'utf8')
	} catch (e: any) {
		problems.push(`${path}: ${e?.message ?? e}`)
		return ''
	}
	sources?.push({ path, bytes: Buffer.byteLength(raw) })
	let text = uncomment(raw)
	let lines = text.split('\n'), output: string[] = []
	let active: boolean | undefined
	let opened = 0
	let fault = (index: number, what: string) => problems.push(`${path}:${index + 1}: ${what}`)
	// ${name} or $name; an unknown name stays as written.
	let substitute = (s: string) => s.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, braced?: string, bare?: string) => vars[(braced ?? bare)!] ?? whole)
	for (let [index, line] of lines.entries()) {
		let start = line.match(/^:{3,}\s+if\s+(.+?)\s*$/)
		if (start) {
			if (active !== undefined) fault(index, 'nested if block')
			let pairs = [...start[1]!.matchAll(/(\w+)="([^"]*)"/g)]
			opened = index + 1
			if (!pairs.length || start[1]!.replace(/(\w+)="[^"]*"/g, '').trim()) {
				fault(index, 'invalid if directive')
				active = false
				continue
			}
			active = pairs.map(([, key, pattern]) => {
				if (!Object.hasOwn(vars, key!)) {
					fault(index, `unknown key ${key}`)
					return false
				}
				let regex = new RegExp(`^${pattern!.replace(/[\\^$+.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
				return regex.test(vars[key!]!)
			}).every(Boolean)
			continue
		}
		if (/^:{3,}\s+else\s*$/.test(line)) {
			if (active === undefined) fault(index, 'else without if')
			else active = !active
			continue
		}
		if (/^:{3,}\s*$/.test(line)) {
			if (active === undefined) fault(index, 'unexpected closing directive')
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
			try {
				let raw = readFileSync(target, 'utf8')
				sources?.push({ path: target, bytes: Buffer.byteLength(raw) })
				output.push(uncomment(raw))
			} catch (e: any) {
				fault(index, `include: ${e?.message ?? e}`)
			}
		} else output.push(substitute(line))
	}
	if (active !== undefined) problems.push(`${path}:${opened}: unclosed if block`)
	return output.join('\n')
}

function assemble(input: PromptInput, sources?: PromptSource[], problems?: string[]): string {
	let fromSource = relative(paths.repoRoot(), resolve(input.cwd))
	let vars = {
		harness: 'hal', model: input.model, date: date(input.now), cwd: paths.display(input.cwd),
		hal_dir: paths.display(paths.repoRoot()), home: paths.home(),
		session_dir: input.sessionId ? paths.display(paths.sessionDir(input.sessionId)) : '',
		tools_summary: actions.summary(),
		hal_source: fromSource !== '..' && !fromSource.startsWith(`..${sep}`) && !isAbsolute(fromSource) ? 'true' : 'false',
		// hal -p --no-user leaves the user's notes out, e.g. for benchmarks.
		user_notes: input.noUser ? 'false' : 'true',
		// The configured web address only; empty without one.
		web_url: String(settings.value('webUrl') ?? '').replace(/\/+$/, ''),
		web_port: String(settings.state.listeningPort ?? settings.webPort()),
	}
	// A missing or broken SYSTEM.md is reported in problems, never thrown.
	let parts = [systemPrompt.preprocess(systemPrompt.file(), vars, sources, problems).trim(), `<date>${date(input.now)}</date>\n<cwd>${input.cwd}</cwd>\n<model>${input.model}</model>`]
	let skillList = skills(input.cwd)
	if (skillList) parts.push(skillList)
	for (let dir of systemPrompt.candidates(input.cwd)) {
		// One file per directory: AGENTS.md, else CLAUDE.md.
		for (let name of ['AGENTS.md', 'CLAUDE.md']) {
			let path = `${dir === '/' ? '' : dir}/${name}`
			let text = read(path)
			if (text === undefined) continue
			sources?.push({ path, bytes: Buffer.byteLength(text) })
			parts.push(`<file path="${path}">\n${uncomment(text).trim()}\n</file>`)
			break
		}
	}
	return parts.join('\n\n')
}

// One assembly path for /system and actual provider requests, so the
// displayed text cannot diverge from what the next request would send.
export type PromptInput = { cwd: string; model: string; now: number; sessionId?: string; noUser?: boolean }
function build(input: PromptInput, problems?: string[]): string {
	return systemPrompt.assemble(input, undefined, problems)
}
function inspect(input: PromptInput): { sources: PromptSource[]; text: string; problems: string[] } {
	let sources: PromptSource[] = [], problems: string[] = []
	return { sources, text: systemPrompt.assemble(input, sources, problems), problems }
}

export const systemPrompt = {
	file: () => systemFile,
	preprocess,
	candidates,
	assemble,
	inspect,
	build,
}
