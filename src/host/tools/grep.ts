// GREP: project search that works the same with or without rg (task
// kjx). The pattern is rg regex syntax; an invalid regex is searched as
// literal |-separated alternatives instead of failing. Missing paths are
// named in the result while the rest are searched.

import { existsSync, readdirSync, statSync } from 'fs'
import { paths } from '../paths.ts'
import { relative, resolve } from 'path'
import { callText } from '../../common/call-text.ts'
import { settings } from '../../common/settings.ts'
import { approval } from '../approval.ts'
import type { Tool, ToolContext, ToolOutput } from '../tools.ts'

type Line = { path: string; line: number; text: string; match: boolean }
type Search = { lines: Line[]; matches: number; files: Set<string>; more: boolean }
type Query = { regex?: string; literals?: string[]; roots: string[]; glob?: string; context: number; cwd: string; signal: AbortSignal }

const maxMatches = 100
const maxFiles = 200
const maxLineChars = 300
// Past this many matches GREP stops reading and says "more than".
const stopAfter = 5000

// GREP "pattern" [ "path" ... ] [ { in, glob, context, files } ]
function resolveCall(raw: string): { name: string; input: Record<string, unknown> } {
	let { values } = callText.values(raw)
	let [pattern, ...rest] = values
	if (typeof pattern !== 'string' || !pattern) throw new Error('GREP needs a pattern first, e.g. GREP "foo|bar" { in: "src" }')
	let input: Record<string, unknown> = { pattern }
	let paths: string[] = []
	for (let v of rest) {
		if (typeof v === 'string') paths.push(v)
		else if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(input, v)
		else throw new Error('GREP takes a pattern, optional paths and an options object, e.g. GREP "foo" { in: ["src", "test"], glob: "*.ts" }')
	}
	if (paths.length) input.in = [...paths, ...[input.in ?? []].flat()]
	return { name: 'grep', input }
}

// Splits on unescaped |; \| stands for a literal |.
function alternatives(pattern: string): string[] {
	let parts = [''], i = 0
	for (; i < pattern.length; i++) {
		if (pattern[i] === '\\' && pattern[i + 1] === '|') { parts[parts.length - 1] += '|'; i++ }
		else if (pattern[i] === '|') parts.push('')
		else parts[parts.length - 1] += pattern[i]!
	}
	return parts.filter(Boolean)
}

function escape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The rg binary, or undefined to use the built-in search.
function rg(): string | undefined {
	return Bun.which('rg') ?? undefined
}

async function withRg(bin: string, q: Query): Promise<Search | { invalid: string }> {
	let args = ['--json', '--sort', 'path', '--hidden', '-g', '!.git', ...(q.context ? ['-C', String(q.context)] : [])]
	if (q.glob) args.push('-g', q.glob)
	if (q.literals) args.push('-F', ...q.literals.flatMap((l) => ['-e', l]))
	else args.push('-e', q.regex!)
	args.push('--', ...q.roots.map((r) => relative(q.cwd, r) || '.'))
	let proc = Bun.spawn([bin, ...args], { cwd: q.cwd, stdout: 'pipe', stderr: 'pipe', signal: q.signal })
	let out: Search = { lines: [], matches: 0, files: new Set(), more: false }
	let buffer = ''
	let decoder = new TextDecoder()
	reading: for await (let chunk of proc.stdout) {
		buffer += decoder.decode(chunk, { stream: true })
		let lines = buffer.split('\n')
		buffer = lines.pop()!
		for (let l of lines) {
			let e: any
			try { e = JSON.parse(l) } catch { continue }
			if (e.type !== 'match' && e.type !== 'context') continue
			let path = (e.data.path.text ?? Buffer.from(e.data.path.bytes, 'base64').toString()).replace(/^\.\//, '')
			let text = (e.data.lines.text ?? '').replace(/\r?\n$/, '')
			let match = e.type === 'match'
			if (match) {
				out.matches++
				out.files.add(path)
				if (out.matches > stopAfter) { out.more = true; proc.kill(); break reading }
			}
			out.lines.push({ path, line: e.data.line_number, text, match })
		}
	}
	let stderr = await new Response(proc.stderr).text()
	let code = await proc.exited
	if (!out.more && code === 2 && /regex parse error/.test(stderr)) return { invalid: stderr.trim() }
	if (!out.more && code === 2 && !out.lines.length) throw new Error(stderr.trim() || 'rg failed')
	return out
}

// Files under the roots that git would track: tracked and untracked
// non-ignored files inside a repository; every file but .git outside one.
function listFiles(q: Query): string[] {
	let rel = q.roots.map((r) => relative(q.cwd, r) || '.')
	let git = Bun.spawnSync(['git', 'ls-files', '-co', '--exclude-standard', '-z', '--', ...rel], { cwd: q.cwd, stdout: 'pipe', stderr: 'pipe' })
	if (git.exitCode === 0) return git.stdout.toString().split('\0').filter((f) => f && existsSync(resolve(q.cwd, f)))
	let files: string[] = []
	let walk = (abs: string) => {
		let st = statSync(abs)
		if (!st.isDirectory()) return void files.push(relative(q.cwd, abs))
		for (let e of readdirSync(abs)) if (e !== '.git') walk(resolve(abs, e))
	}
	q.roots.forEach(walk)
	return files
}

function globMatcher(glob: string | undefined): (path: string) => boolean {
	if (!glob) return () => true
	let negate = glob.startsWith('!')
	let g = new Bun.Glob(negate ? glob.slice(1) : glob)
	let test = glob.includes('/') ? (p: string) => g.match(p) : (p: string) => g.match(p.split('/').pop()!)
	return (p) => test(p) !== negate
}

async function builtIn(q: Query): Promise<Search | { invalid: string }> {
	let regex: RegExp
	try {
		regex = new RegExp(q.literals ? q.literals.map(escape).join('|') : q.regex!, 'u')
	} catch (e: any) {
		return { invalid: e.message }
	}
	let keep = globMatcher(q.glob)
	let out: Search = { lines: [], matches: 0, files: new Set(), more: false }
	for (let path of listFiles(q).filter(keep).sort()) {
		if (q.signal.aborted) throw new Error('stopped')
		let file = Bun.file(resolve(q.cwd, path))
		if (file.size > 10_000_000) continue
		let bytes = await file.bytes()
		if (bytes.subarray(0, 8192).includes(0)) continue
		let lines = new TextDecoder().decode(bytes).split(/\r?\n/)
		if (lines.at(-1) === '') lines.pop()
		let shown = -1
		for (let i = 0; i < lines.length; i++) {
			if (!regex.test(lines[i]!)) continue
			out.matches++
			out.files.add(path)
			if (out.matches > stopAfter) return { ...out, more: true }
			for (let j = Math.max(shown + 1, i - q.context); j <= Math.min(lines.length - 1, i + q.context); j++) {
				let match = j === i || (j > i && regex.test(lines[j]!))
				if (j > i && match) break
				out.lines.push({ path, line: j + 1, text: lines[j]!, match })
				shown = j
			}
		}
	}
	return out
}

function format(found: Search, filesOnly: boolean, separated: boolean): string {
	if (!found.matches) return 'No matches.'
	let total = `${found.more ? 'more than ' : ''}${found.matches} match${found.matches === 1 ? '' : 'es'} in ${found.files.size} file${found.files.size === 1 ? '' : 's'}`
	if (filesOnly) {
		let files = [...found.files]
		return [...files.slice(0, maxFiles), ...(files.length > maxFiles ? [`[+${files.length - maxFiles} more files]`] : [])].join('\n')
	}
	let out: string[] = [], shown = 0, prev: Line | undefined
	for (let l of found.lines) {
		if (l.match && shown === maxMatches) break
		if (l.match) shown++
		if (separated && prev && (prev.path !== l.path || l.line > prev.line + 1)) out.push('--')
		let text = l.text.length > maxLineChars ? `${l.text.slice(0, maxLineChars)}… [line cut]` : l.text
		out.push(`${l.path}${l.match ? ':' : '-'}${l.line}${l.match ? ':' : '-'} ${text}`)
		prev = l
	}
	if (shown < found.matches) out.push(`[${total}; showing the first ${shown}. Narrow with in or glob]`)
	return out.join('\n')
}

export const tool: Tool<ToolOutput> & { rg: () => string | undefined } = {
	name: 'grep',
	description: 'Search file contents under paths (default cwd), skipping git-ignored files. The pattern is a regex (rg syntax); an invalid regex is searched as literal |-separated alternatives. Prints path:line: text, at most 100 matches.',
	readOnly: true,
	syntax: {
		summary: false,
		usage: ['GREP "<pattern>" [ { in: "<path>" | ["<path>", ...], glob: "*.ts", context: 2, files: true } ]'],
		resolve: resolveCall,
	},
	parameters: {
		type: 'object',
		properties: {
			pattern: { type: 'string', description: 'Regex (rg syntax); | separates alternatives' },
			in: { type: ['string', 'array'], items: { type: 'string' }, description: 'Path or paths to search, default cwd' },
			glob: { type: 'string', description: 'Only files matching this glob, e.g. *.ts; a leading ! excludes' },
			context: { type: 'integer', minimum: 0, maximum: 20, description: 'Lines of context around each match' },
			files: { type: 'boolean', description: 'List matching files only' },
		},
		required: ['pattern'],
	},
	rg,
	async run(input, ctx: ToolContext) {
		let pattern = input.pattern
		if (typeof pattern !== 'string' || !pattern) throw new Error('pattern must be a non-empty string')
		let wanted = [input.in ?? '.'].flat()
		if (!wanted.every((p) => typeof p === 'string' && p)) throw new Error('in must be a path or a list of paths')
		if (input.glob !== undefined && typeof input.glob !== 'string') throw new Error('glob must be a string')
		let context = input.context ?? 0
		if (typeof context !== 'number' || !Number.isInteger(context) || context < 0 || context > 20) throw new Error('context must be an integer from 0 to 20')
		let notes: string[] = []
		let roots: string[] = []
		for (let p of wanted as string[]) {
			let abs = resolve(ctx.cwd, paths.expand(p))
			if (!existsSync(abs)) notes.push(`No such path: ${p}`)
			else roots.push(abs)
		}
		if (!roots.length) return { text: notes.join('\n'), isError: true }
		let q: Query = { regex: pattern, roots, glob: input.glob as string | undefined, context, cwd: ctx.cwd, signal: ctx.signal }
		let bin = tool.rg()
		let search = (q: Query) => bin ? withRg(bin, q) : builtIn(q)
		let found = await search(q)
		if ('invalid' in found) {
			let literals = alternatives(pattern)
			notes.push(`Invalid regex, so searched as literal text: ${literals.map((l) => JSON.stringify(l)).join(' or ')}`)
			found = await search({ ...q, regex: undefined, literals })
			if ('invalid' in found) throw new Error(found.invalid)
		}
		if (settings.security() !== 'none') {
			let hidden = new Set([...found.files].filter((f) => approval.sensitive(resolve(ctx.cwd, f))))
			if (hidden.size) {
				found.matches -= found.lines.filter((l) => l.match && hidden.has(l.path)).length
				found.lines = found.lines.filter((l) => !hidden.has(l.path))
				for (let f of hidden) found.files.delete(f)
				notes.push(`Left out ${hidden.size} sensitive file${hidden.size === 1 ? '' : 's'}`)
			}
		}
		return [...notes, format(found, input.files === true, context > 0)].join('\n')
	},
}
