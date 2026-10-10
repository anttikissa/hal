// Hookable prompt assembly from one input snapshot (tasks ar, q5g, ftg).

import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import { settings } from '../common/settings.ts'
import { actions } from './actions.ts'
import { paths } from './paths.ts'
import { promptTemplate, type PromptRender, type PromptSource } from './prompt-template.ts'
export type { PromptSource } from './prompt-template.ts'
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

function agents(cwd: string, sources?: PromptSource[]): string {
	let parts: string[] = []
	let skillList = skills(cwd)
	if (skillList) parts.push(skillList)
	for (let dir of systemPrompt.candidates(cwd)) {
		for (let name of ['AGENTS.md', 'CLAUDE.md']) {
			let path = `${dir === '/' ? '' : dir}/${name}`, text = read(path)
			if (text === undefined) continue
			sources?.push({ path, bytes: Buffer.byteLength(text) })
			parts.push(`<file path="${path}">\n${promptTemplate.uncomment(text).trim()}\n</file>`)
			break
		}
	}
	return parts.join('\n\n')
}

function assemble(input: PromptInput, sources?: PromptSource[], problems?: string[]): string {
	let fromSource = relative(paths.repoRoot(), resolve(input.cwd))
	let slots = input.slots ?? settings.subagentSlots()
	let vars = {
		harness: 'hal', model: input.model, date: date(input.now), cwd: paths.display(input.cwd),
		hal_dir: paths.display(paths.repoRoot()), home: paths.home(),
		session_dir: input.sessionId ? paths.display(paths.sessionDir(input.sessionId)) : '',
		// With no spawn slots the agent is not told spawning exists.
		tools_summary: actions.summary(slots === 0 ? ['spawn', 'wait'] : []),
		hal_source: fromSource !== '..' && !fromSource.startsWith(`..${sep}`) && !isAbsolute(fromSource) ? 'true' : 'false',
		user_notes: input.noUser ? 'false' : 'true', web_url: settings.webUrl(), interactive: String(input.interactive ?? true),
		kind: input.kind ?? 'interactive', subagent: input.owner ? 'true' : 'false',
		owner: input.owner ?? '', parent: input.parent ?? '', fork: input.parent ? 'true' : 'false',
		subagent_slots: String(slots), autoclose: String(input.autoclose ?? false),
		agents: systemPrompt.agents(input.cwd, sources),
	}
	return systemPrompt.preprocess(systemPrompt.file(), vars, sources, problems, input.rendered)
}

export type PromptInput = { cwd: string; model: string; now: number; sessionId?: string; noUser?: boolean; interactive?: boolean; owner?: string; parent?: string; kind?: string; slots?: number; autoclose?: boolean; rendered?: PromptRender }
function build(input: PromptInput, problems?: string[]): string {
	return systemPrompt.assemble(input, undefined, problems)
}
function inspect(input: PromptInput): { sources: PromptSource[]; text: string; problems: string[]; sections: PromptRender['sections'] } {
	let sources: PromptSource[] = [], problems: string[] = [], rendered: PromptRender = { sections: [] }
	let text = systemPrompt.assemble({ ...input, rendered }, sources, problems)
	let shift = text.indexOf(rendered.text ?? text)
	let sections = rendered.sections.flatMap((s) => {
		if (!s.body.trim()) return [s]
		let start = shift >= 0 ? s.start + shift : text.indexOf(`# ${s.title}\n${s.body}`)
		return start < 0 ? [] : [{ ...s, start, end: start + s.end - s.start }]
	})
	return { sources, text, problems, sections }
}

export const systemPrompt = {
	file: () => systemFile,
	preprocess: (...args: Parameters<typeof promptTemplate.render>) => promptTemplate.render(...args),
	agents,
	candidates,
	assemble,
	inspect,
	build,
}
