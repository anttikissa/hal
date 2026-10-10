import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, resolve } from 'path'

export type PromptSource = { path: string; bytes: number }
export type PromptSection = { title: string; body: string; update: 'full' | 'diff'; variables: string[]; start: number; end: number }
export type PromptRender = { sections: PromptSection[]; text?: string }
type Frame = { kind: 'if' | 'section'; colons: number; line: number; active: boolean; parent: boolean; alternate?: boolean; keys: string[]; section?: PromptSection; lines?: string[] }
const uncomment = (text: string) => text.replace(/<!--[^]*?-->/g, '')
const trimLines = (text: string) => text.replace(/^(?:[\t ]*\n)+|(?:\n[\t ]*)+$/g, '')

function render(file: string, vars: Record<string, string>, sources: PromptSource[] = [], problems: string[] = [], rendered?: PromptRender): string {
	let path = resolve(file), raw: string
	try { raw = readFileSync(path, 'utf8') }
	catch (e: any) { problems.push(`${path}: ${e?.message ?? e}`); return '' }
	sources.push({ path, bytes: Buffer.byteLength(raw) })
	let stack: Frame[] = [], titles = new Set<string>(), parts: (string | PromptSection)[] = [], text: string[] = []
	let active = () => stack.every((f) => f.active)
	let fault = (line: number, what: string) => problems.push(`${path}:${line}: ${what}`)
	let substitute = (s: string) => s.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, braced?: string, bare?: string) => vars[(braced ?? bare)!] ?? whole)
	let flush = () => { let s = trimLines(text.join('\n')); if (s.trim()) parts.push(s); text = [] }
	let add = (s: string) => {
		let section = stack.find((f) => f.kind === 'section')
		if (section) section.lines!.push(s)
		else text.push(s)
	}
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
		if (directive) {
			let colons = directive[1]!.length, command = directive[2] ?? ''
			if (!command) {
				let frame = stack.pop()
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
				let frame = stack.at(-1)
				if (frame?.kind !== 'if') fault(n, 'else without if')
				else if (frame.colons !== colons) fault(n, `else fence has ${colons} colons; expected ${frame.colons}`)
				else if (frame.alternate) fault(n, 'duplicate else')
				else { frame.alternate = true; frame.active = !frame.active }
				continue
			}
			if (command.startsWith('if ')) {
				let condition = command.slice(3), pairs = [...condition.matchAll(/(\w+)="([^"]*)"/g)]
				if (!pairs.length || condition.replace(/(\w+)="[^"]*"/g, '').trim()) fault(n, 'invalid if directive')
				let matches = pairs.map(([, key, pattern]) => {
					if (!Object.hasOwn(vars, key!)) { fault(n, `unknown key ${key}`); return false }
					let regex = new RegExp(`^${pattern!.replace(/[\\^$+.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
					return regex.test(vars[key!]!)
				}).every(Boolean)
				let section = stack.find((f) => f.kind === 'section')?.section
				section?.variables.push(...pairs.map((p) => p[1]!))
				stack.push({ kind: 'if', colons, line: n, active: matches, parent: active(), keys: pairs.map((p) => p[1]!) })
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
		try {
			let body = readFileSync(target, 'utf8')
			sources.push({ path: target, bytes: Buffer.byteLength(body) })
			add(uncomment(body))
		} catch (e: any) { fault(n, `include: ${e?.message ?? e}`) }
	}
	for (let f of stack) fault(f.line, `unclosed ${f.kind} block`)
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
	if (rendered) rendered.text = output
	return output
}

export const promptTemplate = { render, uncomment }
