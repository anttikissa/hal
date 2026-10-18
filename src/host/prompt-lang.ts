// Renders SYSTEM.md and the files it includes into the system prompt.
//
// Template language reference:
//
// Text
// - HTML comments are stripped; lines that held only a comment disappear.
//   Comments do not nest: a stray --> or an unclosed <!-- is an error.
// - $name and ${name} expand variables. Unknown names stay as written.
// - All variable values are strings.
//
// Includes (a line by itself)
// - @path inserts the file, rendered as a template.
// - @?path does the same, but skips the line if the file does not exist.
// - The path may use variables and ~/, and resolves relative to the
//   including file. A cycle or unreadable file is an error.
//
// Fenced blocks
// - A directive line starts with two or more colons: `:: if ...`.
// - A line with only the same number of colons closes the block.
//   Nest blocks by using more colons for inner blocks.
//
// Conditionals: `:: if <condition>` ... `:: else` ... `::`
// - Operands are $variables or "quoted text".
// - $x alone is false when empty, 0, false, no or off (any case), else true.
// - !$x negates it. ! works only directly before a variable.
// - $a == $b and $a != $b compare exactly.
// - $a like "glob" matches the whole value; * and ? are wildcards.
// - Join conditions with &&; all must hold.
// - Anything else, including an unknown variable, is an error.
// - :: else, at the same colon count, selects the alternate branch; at most one.
// - Conditionals nest and may contain sections.
//
// Sections: `:: section "Title"` ... `::`
// - Renders as "# Title" followed by the body. An empty section renders
//   nothing, not even its heading.
// - Titles are unique and non-empty. Sections cannot nest.
// - The provider's prompt cache needs a fixed system prompt, so it never
//   changes during a session. When a section's content changes (new cwd,
//   new skill, edited AGENTS.md), Hal appends the new section to the
//   transcript as a <hal-note>. update="diff" sends a diff instead, showing
//   the model both old and new values.
// - Text outside sections has no such update path: changing it during a
//   session invalidates the cache. Put everything in a section; a section
//   costs only its heading.
//
// Errors carry file:line. A broken template keeps the last valid prompt.
//
// Plain mode (options.root; AGENTS.md and CLAUDE.md, Claude Code
// compatible, task d2j): only a line that is just @path is processed. It
// becomes that file's text, also plain, when its real path lies inside
// root; a missing file, a path outside root and a cycle's closing line stay
// verbatim, so a repo cannot pull in ~/.ssh. Comments, variables and
// directives stay verbatim too. The project-boundary test stays
// (system-prompt.test.ts). The rest was tested once, then the tests were
// deleted. If you change this code, first write tests for: a nested
// in-project import expands; a missing file, a cycle's closing line and an
// inline @ stay verbatim.

import { existsSync, readFileSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'

export type PromptSource = { path: string; bytes: number }
export type PromptSection = { title: string; body: string; update: 'full' | 'diff'; variables: string[]; start: number; end: number }
export type PromptRender = { sections: PromptSection[]; text?: string; vars?: Record<string, string> }
type Frame = { kind: 'if' | 'section'; colons: number; line: number; active: boolean; parent: boolean; alternate?: boolean; keys: string[]; section?: PromptSection; lines?: string[] }
const trimLines = (text: string) => text.replace(/^(?:[\t ]*\n)+|(?:\n[\t ]*)+$/g, '')
// A bare `if $x` is false for "", 0, false, no and off (any case); true for anything else.
const truthy = (value: string) => !/^(|0|false|no|off)$/i.test(value.trim())

function render(file: string, vars: Record<string, string>, sources: PromptSource[] = [], problems: string[] = [], rendered?: PromptRender, options: { root?: string } = {}): string {
	let stack: Frame[] = [], titles = new Set<string>(), parts: (string | PromptSection)[] = [], text: string[] = []
	let active = () => stack.every((f) => f.active)
	let substitute = (s: string) => s.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, braced?: string, bare?: string) => vars[(braced ?? bare)!] ?? whole)
	let flush = () => { let s = trimLines(text.join('\n')); if (s.trim()) parts.push(s); text = [] }
	let add = (s: string) => {
		let section = stack.find((f) => f.kind === 'section')
		if (section) section.lines!.push(s)
		else text.push(s)
	}
	let insideRoot = (from: string, name: string, chain: string[]) => {
		try {
			let target = realpathSync(resolve(dirname(from), name)), rel = relative(options.root!, target)
			if (!rel || rel.split(sep)[0] === '..' || isAbsolute(rel) || chain.includes(target)) return
			return { target, body: readFileSync(target, 'utf8') }
		} catch {}
	}
	let run = (path: string, raw: string, chain: string[]) => {
		sources.push({ path, bytes: Buffer.byteLength(raw) })
		if (options.root !== undefined) {
			for (let line of raw.trim().split('\n')) {
				let name = /^\s*@(\S+)\s*$/.exec(line)?.[1], found = name ? insideRoot(chain.at(-1)!, name, chain) : undefined
				if (found) run(found.target, found.body, [...chain, found.target])
				else add(line)
			}
			return
		}
		let depth = stack.length
		let fault = (line: number, what: string) => problems.push(`${path}:${line}: ${what}`)
		let commentLines = new Set<number>(), cursor = 0, lineNumber = 0
		let template = raw.replace(/<!--[^]*?-->/g, (comment: string, offset: number) => {
			lineNumber += raw.slice(cursor, offset).split('\n').length - 1
			let count = comment.split('\n').length - 1
			for (let i = 0; i <= count; i++) commentLines.add(lineNumber + i)
			lineNumber += count; cursor = offset + comment.length
			return '\n'.repeat(count)
		})
		for (let [index, line] of template.split('\n').entries()) {
			if (!line.trim() && commentLines.has(index)) continue
			let n = index + 1, directive = /^(:{2,})(?:\s+(.*?))?\s*$/.exec(line)
			if (line.includes('-->')) fault(n, 'stray --> (comments do not nest)')
			if (line.includes('<!--')) fault(n, 'unclosed <!--')
			if (directive) {
				let colons = directive[1]!.length, command = directive[2] ?? ''
				if (!command) {
					let frame = stack.length > depth ? stack.pop() : undefined
					if (!frame) { fault(n, 'unexpected closing directive'); continue }
					if (frame.colons !== colons) fault(n, `closing fence has ${colons} colons; expected ${frame.colons}`)
					if (frame.kind === 'section' && frame.section) {
						frame.section.body = trimLines(frame.lines!.join('\n'))
						if (!frame.parent) frame.section.body = ''
						parts.push(frame.section)
					}
					continue
				}
				if (command === 'else') {
					let frame = stack.length > depth ? stack.at(-1) : undefined
					if (frame?.kind !== 'if') fault(n, 'else without if')
					else if (frame.colons !== colons) fault(n, `else fence has ${colons} colons; expected ${frame.colons}`)
					else if (frame.alternate) fault(n, 'duplicate else')
					else { frame.alternate = true; frame.active = !frame.active }
					continue
				}
				if (command.startsWith('if ')) {
					let keys: string[] = [], operand = (token: string) => {
						let name = /^\$\{?(\w+)\}?$/.exec(token)?.[1]
						if (name === undefined) return token.slice(1, -1)
						keys.push(name)
						if (Object.hasOwn(vars, name)) return vars[name]!
						fault(n, `unknown key ${name}`)
					}
					let value = String.raw`(\$\{?\w+\}?|"[^"]*")`
					let test = new RegExp(String.raw`^\s*(!?)\s*(\$\{?\w+\}?)\s*$`), compare = new RegExp(String.raw`^\s*${value}\s*(==|!=|\slike\s)\s*${value}\s*$`)
					let matches = command.slice(3).split(/&&(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((text) => {
						let bare = test.exec(text)
						if (bare) {
							let v = operand(bare[2]!)
							return v !== undefined && truthy(v) !== (bare[1] === '!')
						}
						let parts = compare.exec(text)
						if (!parts) { fault(n, 'invalid if directive; use $key, !$key, $key == "text", $key != $other or $key like "glob*", joined by &&'); return false }
						let left = operand(parts[1]!), right = operand(parts[3]!)
						if (left === undefined || right === undefined) return false
						if (parts[2] === '==') return left === right
						if (parts[2] === '!=') return left !== right
						return new RegExp(`^${right.replace(/[\\^$+.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(left)
					}).every(Boolean)
					let section = stack.find((f) => f.kind === 'section')?.section
					section?.variables.push(...keys)
					stack.push({ kind: 'if', colons, line: n, active: matches, parent: active(), keys })
					continue
				}
				let section = /^section\s+"([^"]*)"(?:\s+update="(diff)")?$/.exec(command)
				if (section) {
					if (stack.some((f) => f.kind === 'section')) { fault(n, 'sections cannot nest'); continue }
					let title = section[1]!
					if (!title.trim()) fault(n, 'section title is empty')
					if (titles.has(title)) fault(n, `duplicate section title ${JSON.stringify(title)}`)
					titles.add(title)
					flush()
					stack.push({ kind: 'section', colons, line: n, active: true, parent: active(), keys: [], lines: [], section: { title, body: '', update: section[2] ? 'diff' : 'full', variables: stack.flatMap((f) => f.keys), start: 0, end: 0 } })
					continue
				}
				fault(n, `invalid directive ${command}`)
				continue
			}
			let section = stack.find((f) => f.kind === 'section')?.section
			if (section) for (let match of line.matchAll(/\$\{(\w+)\}|\$(\w+)/g)) section.variables.push((match[1] ?? match[2])!)
			if (!active()) continue
			let include = /^@(\??)(\S+)\s*$/.exec(line)
			if (!include) { add(substitute(line)); continue }
			let name = substitute(include[2]!)
			if (name.startsWith('~/')) name = resolve(homedir(), name.slice(2))
			let target = resolve(dirname(path), name)
			if (include[1] && !existsSync(target)) continue
			if (chain.includes(target)) { fault(n, `include cycle: ${target}`); continue }
			let body: string
			try { body = readFileSync(target, 'utf8') }
			catch (e: any) { fault(n, `include: ${e?.message ?? e}`); continue }
			run(target, body, [...chain, target])
		}
		for (let f of stack.splice(depth)) fault(f.line, `unclosed ${f.kind} block`)
	}
	let path = resolve(file), raw: string
	try { raw = readFileSync(path, 'utf8') }
	catch (e: any) { problems.push(`${path}: ${e?.message ?? e}`); return '' }
	let real = path
	if (options.root !== undefined) try { real = realpathSync(path) } catch {}
	run(path, raw, [real])
	flush()
	let output = ''
	for (let part of parts) {
		if (typeof part === 'string') { if (output) output += '\n\n'; output += part; continue }
		part.variables = [...new Set(part.variables)]
		if (part.body.trim()) {
			if (output) output += '\n\n'
			part.start = output.length
			output += `# ${part.title}\n${part.body}`
			part.end = output.length
		}
		rendered?.sections.push(part)
	}
	if (rendered) Object.assign(rendered, { text: output, vars })
	return output
}

export const promptLang = { render }
