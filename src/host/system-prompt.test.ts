import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { systemPrompt } from './system-prompt.ts'

let root = ''

beforeEach(() => {
	root = mkdtempSync(`${tmpdir()}/hal-system-`)
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

const at = new Date(2026, 8, 26, 1, 52).getTime()

test('purpose guidance follows interaction mode, not subagent kind or autoclose', () => {
	let input = { cwd: root, model: 'm/x', now: at, noUser: true, owner: '01-abc', kind: 'subagent', autoclose: true }
	expect(systemPrompt.build(input)).toContain('BASH /*')
	let unattended = systemPrompt.inspect({ ...input, interactive: false })
	expect(unattended.problems).toEqual([])
	expect(unattended.text).not.toContain('/*')
	expect(unattended.text).toContain('unsafeToStop')
	expect(unattended.text).toContain('modifies')
	expect(unattended.text).toContain('path')
})

test('with no spawn slots the prompt never mentions spawning', () => {
	let input = { cwd: root, model: 'm/x', now: at, noUser: true }
	expect(systemPrompt.build({ ...input, slots: 2 })).toContain('SPAWN')
	let none = systemPrompt.inspect({ ...input, slots: 0 })
	expect(none.problems).toEqual([])
	expect(none.text).not.toMatch(/spawn|subagent|budget|WAIT/i)
})

test('says who, when and where: date, cwd and model', () => {
	mkdirSync(`${root}/work`)
	let text = systemPrompt.build({ cwd: `${root}/work`, model: 'anthropic/claude-x', now: at })
	expect(text).toContain('2026-09-26')
	expect(text).toContain(`${root}/work`)
	expect(text).toContain('anthropic/claude-x')
})

test('in Git, one file per directory from the repo root down to the cwd, outermost first', () => {
	mkdirSync(`${root}/repo/.git`, { recursive: true })
	mkdirSync(`${root}/repo/b/c`, { recursive: true })
	writeFileSync(`${root}/AGENTS.md`, 'ABOVE REPO')
	writeFileSync(`${root}/repo/AGENTS.md`, 'OUTER RULE')
	writeFileSync(`${root}/repo/b/CLAUDE.md`, 'MIDDLE CLAUDE')
	writeFileSync(`${root}/repo/b/c/AGENTS.md`, 'INNER RULE')
	writeFileSync(`${root}/repo/b/c/CLAUDE.md`, 'INNER CLAUDE')
	let text = systemPrompt.build({ cwd: `${root}/repo/b/c`, model: 'm/x', now: at })
	let outer = text.indexOf('OUTER RULE'), middle = text.indexOf('MIDDLE CLAUDE'), inner = text.indexOf('INNER RULE')
	expect(outer).toBeGreaterThanOrEqual(0)
	expect(middle).toBeGreaterThan(outer)
	expect(inner).toBeGreaterThan(middle)
	expect(text).toContain(`${root}/repo/AGENTS.md`)
	expect(text).toContain(`${root}/repo/b/CLAUDE.md`)
	// AGENTS.md wins over CLAUDE.md in the same directory; nothing above the repo.
	expect(text).not.toContain('INNER CLAUDE')
	expect(text).not.toContain('ABOVE REPO')
})

test('outside Git only the cwd itself is read', () => {
	mkdirSync(`${root}/a/b`, { recursive: true })
	writeFileSync(`${root}/a/AGENTS.md`, 'PARENT RULE')
	writeFileSync(`${root}/a/b/CLAUDE.md`, 'HERE RULE')
	let text = systemPrompt.build({ cwd: `${root}/a/b`, model: 'm/x', now: at })
	expect(text).toContain('HERE RULE')
	expect(text).not.toContain('PARENT RULE')
})

test('the date names the UTC offset of the clock prompt stamps use', () => {
	let tz = process.env.TZ
	try {
		let noon = Date.UTC(2026, 8, 26, 21, 30)
		process.env.TZ = 'UTC'
		expect(systemPrompt.build({ cwd: root, model: 'm/x', now: noon })).toMatch(/2026-09-26, Saturday\b.*UTC(?![+-])/)
		process.env.TZ = 'Asia/Kolkata'
		expect(systemPrompt.build({ cwd: root, model: 'm/x', now: noon })).toMatch(/2026-09-27, Sunday\b.*UTC\+05:30/)
	} finally {
		if (tz === undefined) delete process.env.TZ
		else process.env.TZ = tz
	}
})

test('the same inputs give the same text; a changed input changes it', () => {
	mkdirSync(`${root}/work`)
	let input = { cwd: `${root}/work`, model: 'm/x', now: at }
	let first = systemPrompt.build(input)
	expect(systemPrompt.build({ ...input, now: at + 60_000 })).toBe(first)
	writeFileSync(`${root}/work/AGENTS.md`, 'NEW RULE')
	expect(systemPrompt.build(input)).toContain('NEW RULE')
	expect(systemPrompt.build({ ...input, now: at + 86_400_000 })).not.toBe(first)
})

test('SYSTEM.md is read per build: an edit shows on the next one, no edit keeps the text', () => {
	let orig = systemPrompt.file
	try {
		systemPrompt.file = () => `${root}/SYSTEM.md`
		writeFileSync(`${root}/SYSTEM.md`, 'You are Hal.\n- FIRST RULE\n')
		let input = { cwd: `${root}/gone`, model: 'm/x', now: at }
		let first = systemPrompt.build(input)
		expect(first.startsWith('You are Hal.\n- FIRST RULE')).toBe(true)
		expect(systemPrompt.build(input)).toBe(first)
		writeFileSync(`${root}/SYSTEM.md`, 'You are Hal.\n- SECOND RULE\n')
		let second = systemPrompt.build(input)
		expect(second).toContain('SECOND RULE')
		expect(second).not.toContain('FIRST RULE')
		rmSync(`${root}/SYSTEM.md`)
		let problems: string[] = []
		expect(systemPrompt.build(input, problems)).toBe('')
		expect(problems.join()).toContain(`${root}/SYSTEM.md`)
	} finally {
		systemPrompt.file = orig
	}
})

test('SYSTEM preprocessing removes comments and selects every matching condition; project files only lose comments', () => {
	let old = systemPrompt.file
	try {
		systemPrompt.file = () => `${root}/SYSTEM.md`
		writeFileSync(`${root}/SYSTEM.md`, 'You are Hal.<!-- secret\non another line -->\n::: if model="anthropic/*" harness="hal"\nCLAUDE ONLY\n:::\n::: if model="openai/*"\nOPENAI ONLY\n:::\n${model} ${unknown}\n$agents')
		writeFileSync(`${root}/AGENTS.md`, '<!-- gone -->kept\n::: if model="openai/*"')
		let text = systemPrompt.build({ cwd: root, model: 'anthropic/claude-x', now: at })
		expect(text).toContain('CLAUDE ONLY')
		expect(text).not.toContain('OPENAI ONLY')
		expect(text).not.toContain('secret')
		expect(text).toContain('anthropic/claude-x ${unknown}')
		expect(text).not.toContain('gone')
		expect(text).toContain('kept')
		expect(text).toContain('::: if model="openai/*"')
		expect(systemPrompt.build({ cwd: root, model: 'openai/gpt', now: at })).toContain('OPENAI ONLY')
	} finally { systemPrompt.file = old }
})

test('bad SYSTEM directives never throw: each is reported with its line and the rest of the prompt applies', () => {
	let old = systemPrompt.file
	try {
		systemPrompt.file = () => `${root}/SYSTEM.md`
		let build = (body: string) => {
			writeFileSync(`${root}/SYSTEM.md`, body)
			let problems: string[] = []
			return { text: systemPrompt.build({ cwd: root, model: 'other/x', now: at }, problems), problems: problems.join('\n') }
		}
		let unknown = build('Hello\n::: if unknown="true"\nDROPPED\n:::\nAfter')
		expect(unknown.problems).toMatch(/SYSTEM.md:2: unknown key unknown/)
		expect(unknown.text).toContain('Hello\nAfter')
		expect(unknown.text).not.toContain('DROPPED')
		let unclosed = build('Hello\n::: if model="*"\ntext')
		expect(unclosed.problems).toMatch(/SYSTEM.md:2: unclosed/)
		expect(unclosed.text).toContain('Hello\ntext')
	} finally { systemPrompt.file = old }
})

test('SYSTEM includes lose comments but keep directives, nested includes and variables literally', () => {
	let old = systemPrompt.file
	try {
		systemPrompt.file = () => `${root}/SYSTEM.md`
		mkdirSync(`${root}/more`)
		let raw = '::: if model="wrong/*"\n@../SYSTEM.md\n${model}\n:::\n@?missing.md\n'
		writeFileSync(`${root}/more/part.md`, `<!-- note\nfor me -->${raw}`)
		writeFileSync(`${root}/SYSTEM.md`, 'Hello\n@more/part.md\n@?absent.md')
		let text = systemPrompt.build({ cwd: root, model: 'm/x', now: at })
		expect(text).toContain(raw.trimEnd())
		expect(text).not.toContain('for me')
		expect(text).not.toContain('@?absent.md')
		writeFileSync(`${root}/SYSTEM.md`, 'Before\n@missing.md\nAfter')
		let problems: string[] = []
		expect(systemPrompt.build({ cwd: root, model: 'm/x', now: at }, problems)).toContain('Before\nAfter')
		expect(problems.join()).toMatch(/SYSTEM.md:2: include: .*missing.md/)
	} finally { systemPrompt.file = old }
})

test('the home USER.md appears in the real SYSTEM prompt when present, with no residue when absent', () => {
	let old = process.env.HAL_HOME
	try {
		process.env.HAL_HOME = root
		let input = { cwd: `${root}/work`, model: 'm/x', now: at }
		let without = systemPrompt.build(input)
		writeFileSync(`${root}/USER.md`, '# User\n\nName: Rowan\n\nPrefers concise answers.\n')
		let withUser = systemPrompt.build(input)
		expect(withUser).toContain('Name: Rowan')
		let noUser = true
		expect(systemPrompt.build({ ...input, noUser })).not.toContain('Name: Rowan')
		expect(withUser).toContain('Prefers concise answers.')
		// The only addition is the optional file, not a printed include path.
		expect(withUser).not.toContain('@?')
		rmSync(`${root}/USER.md`)
		expect(systemPrompt.build(input)).toBe(without)
	} finally {
		if (old === undefined) delete process.env.HAL_HOME
		else process.env.HAL_HOME = old
	}
})

test('skills are listed by name: Hal skills always, project skills only along the cwd chain', () => {
	let skill = (dir: string) => (mkdirSync(dir, { recursive: true }), writeFileSync(`${dir}/SKILL.md`, '---\nname: x\n---\nBODY TEXT'))
	mkdirSync(`${root}/repo/.git`, { recursive: true })
	skill(`${root}/repo/.agents/skills/zeta`)
	skill(`${root}/repo/.agents/skills/alpha`)
	mkdirSync(`${root}/repo/.agents/skills/no-skill-file`)
	skill(`${root}/repo/sub/.claude/skills/inner`)
	skill(`${root}/repo/other/.agents/skills/elsewhere`)
	mkdirSync(`${root}/repo/sub/deep`, { recursive: true })
	let text = systemPrompt.build({ cwd: `${root}/repo/sub/deep`, model: 'm/x', now: at })
	expect(text).toMatch(new RegExp(`Skills - read <dir>/SKILL.md when appropriate: \\S+/skills/\\S*hal-server-install\\S* ${root}/repo/.agents/skills/\\{alpha,zeta\\} ${root}/repo/sub/.claude/skills/inner$`))
	// Folders without SKILL.md, projects off the chain and skill bodies stay out.
	expect(text).not.toContain('no-skill-file')
	expect(text).not.toContain('elsewhere')
	expect(text).not.toContain('BODY TEXT')
	// Outside that project only the Hal skills remain.
	let away = systemPrompt.build({ cwd: root, model: 'm/x', now: at })
	expect(away).toMatch(/\/skills\/\S*hal-server-install/)
	expect(away).not.toContain('alpha')
})
