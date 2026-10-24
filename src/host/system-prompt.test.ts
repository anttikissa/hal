import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { systemPrompt } from './system-prompt.ts'
import { clients } from './clients.ts'
import { paths } from './paths.ts'
import { projectContext } from './project-context.ts'
let savedHome = paths.state.home
let root = ''

beforeEach(() => {
	root = mkdtempSync(`${tmpdir()}/hal-system-`)
	paths.state.home = root
})

afterEach(() => {
	projectContext.reset()
	paths.state.home = savedHome
	rmSync(root, { recursive: true, force: true })
})

const at = new Date(2026, 8, 26, 1, 52).getTime()

test('execution guidance follows interaction mode, not subagent kind or autoclose', () => {
	let input = { cwd: root, model: 'm/x', now: at, noUser: true, parent: '01-abc', kind: 'subagent', autoclose: true }
	let interactive = systemPrompt.inspect(input)
	expect(interactive.text).toContain('BASH /*')
	expect(interactive.sections.find((s) => s.title === 'BASH')?.body).toContain(
		'Long-running commands must use background: true',
	)
	let unattended = systemPrompt.inspect({ ...input, interactive: false })
	expect(unattended.problems).toEqual([])
	expect(unattended.text).not.toContain('/*')
	expect(unattended.text).toContain('unsafeToStop')
	expect(unattended.text).toContain('modifies')
	expect(unattended.text).toContain('path')
	let bash = unattended.sections.find((s) => s.title === 'BASH')?.body
	expect(bash).toContain('foreground')
	expect(bash).toContain('parallel work')
	expect(bash).toContain('WAIT for completion')
})

test('a hook that rewrites a tool guide changes only that section; a removed heading withdraws its section', () => {
	let input = { cwd: root, model: 'm/x', now: at, noUser: true }
	let plain = systemPrompt.inspect(input),
		assemble = systemPrompt.assemble
	systemPrompt.assemble = (...args) =>
		assemble(...args)
			.replace(/(# EDIT\n)[\s\S]*?(?=\n\n# )/, '$1- Use EDIT blocks.\n  !!NEW example')
			.replace(/\n\n# WRITE\n[\s\S]*?(?=\n\n# )/, '')
	try {
		let hooked = systemPrompt.inspect(input)
		let outside = (r: typeof plain) =>
			r.sections
				.filter((s) => s.body.trim())
				.reduceRight((t, s) => t.slice(0, s.start) + t.slice(s.end), r.text)
				.replace(/\n{3,}/g, '\n\n')
		expect(outside(hooked)).toBe(outside(plain))
		expect(hooked.sections.find((s) => s.title === 'EDIT')?.body).toBe('- Use EDIT blocks.\n  !!NEW example')
		expect(hooked.sections.some((s) => s.title === 'WRITE')).toBe(false)
		for (let s of hooked.sections.filter((s) => s.body.trim()))
			expect(hooked.text.slice(s.start, s.end)).toBe(`# ${s.title}\n${s.body}`)
	} finally {
		systemPrompt.assemble = assemble
	}
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
	projectContext.decide(`${root}/repo`, true)
	let text = systemPrompt.build({ cwd: `${root}/repo/b/c`, model: 'm/x', now: at })
	let outer = text.indexOf('OUTER RULE'),
		middle = text.indexOf('MIDDLE CLAUDE'),
		inner = text.indexOf('INNER RULE')
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
	projectContext.decide(`${root}/a/b`, true)
	let text = systemPrompt.build({ cwd: `${root}/a/b`, model: 'm/x', now: at })
	expect(text).toContain('HERE RULE')
	expect(text).not.toContain('PARENT RULE')
})

test('@path imports never read outside the project, even through a symlink', () => {
	mkdirSync(`${root}/repo/.git`, { recursive: true })
	writeFileSync(`${root}/SECRET`, 'SECRET TEXT')
	symlinkSync(`${root}/SECRET`, `${root}/repo/link`)
	writeFileSync(`${root}/repo/inside.md`, 'INSIDE TEXT')
	writeFileSync(`${root}/repo/AGENTS.md`, '@inside.md\n@../SECRET\n@link')
	projectContext.decide(`${root}/repo`, true)
	let text = systemPrompt.build({ cwd: `${root}/repo`, model: 'm/x', now: at })
	expect(text).toContain('INSIDE TEXT\n@../SECRET\n@link')
	expect(text).not.toContain('SECRET TEXT')
})

test('without a client, the date uses the host local timezone and offset', () => {
	let now = Date.UTC(2026, 8, 26, 21, 30)
	let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
	let session = systemPrompt.inspect({ cwd: root, model: 'm/x', now }).sections.find((s) => s.title === 'Session')!
	expect(session.body).toContain(`Timezone: ${timezone}`)
	let parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
	let part = (type: string) => parts.find((p) => p.type === type)!.value
	expect(session.body).toContain(`${part('year')}-${part('month')}-${part('day')}`)
})

test('the Session section uses the client zone and follows zone changes on a UTC host', () => {
	let tz = process.env.TZ
	let client = clients.join(new Set(['timezone-test']))
	try {
		process.env.TZ = 'UTC'
		let input = { cwd: root, model: 'm/x', now: Date.UTC(2026, 8, 26, 23, 30), sessionId: 'timezone-test' }
		let session = () => systemPrompt.inspect(input).sections.find((s) => s.title === 'Session')!
		expect(session().body).toContain('Timezone: UTC')
		clients.input(client, { type: 'tab-start', timezone: 'Asia/Tokyo' })
		expect(session().body).toContain('Timezone: Asia/Tokyo')
		expect(session().body).toContain('2026-09-27, Sunday, UTC+09:00')
		clients.input(client, { type: 'tab-resume', timezone: 'America/New_York' })
		expect(session().body).toContain('Timezone: America/New_York')
		expect(session().body).toContain('2026-09-26, Saturday, UTC-04:00')
	} finally {
		clients.state.records.delete(client)
		if (tz === undefined) delete process.env.TZ
		else process.env.TZ = tz
	}
})

test('the same inputs give the same text; a changed input changes it', () => {
	mkdirSync(`${root}/work`)
	let input = { cwd: `${root}/work`, model: 'm/x', now: at }
	projectContext.decide(`${root}/work`, true)
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

test('SYSTEM preprocessing removes comments and selects every matching condition; project files stay verbatim', () => {
	let old = systemPrompt.file
	try {
		systemPrompt.file = () => `${root}/SYSTEM.md`
		writeFileSync(
			`${root}/SYSTEM.md`,
			'You are Hal.<!-- secret\non another line -->\n::: if $session_model like "anthropic/*"\nCLAUDE ONLY\n:::\n::: if $session_model like "openai/*"\nOPENAI ONLY\n:::\n${session_model} ${unknown}\n$agents',
		)
		writeFileSync(`${root}/AGENTS.md`, '<!-- gone -->kept\n::: if $session_model like "openai/*"')
		projectContext.decide(root, true)
		let text = systemPrompt.build({ cwd: root, model: 'anthropic/claude-x', now: at })
		expect(text).toContain('CLAUDE ONLY')
		expect(text).not.toContain('OPENAI ONLY')
		expect(text).not.toContain('secret')
		expect(text).toContain('anthropic/claude-x ${unknown}')
		expect(text).toContain('<!-- gone -->kept')
		expect(text).toContain('::: if $session_model like "openai/*"')
		expect(systemPrompt.build({ cwd: root, model: 'openai/gpt', now: at })).toContain('OPENAI ONLY')
	} finally {
		systemPrompt.file = old
	}
})

test('bad SYSTEM directives never throw: each is reported with its line and the rest of the prompt applies', () => {
	let old = systemPrompt.file
	try {
		systemPrompt.file = () => `${root}/SYSTEM.md`
		let build = (body: string) => {
			writeFileSync(`${root}/SYSTEM.md`, body)
			let problems: string[] = []
			return {
				text: systemPrompt.build({ cwd: root, model: 'other/x', now: at }, problems),
				problems: problems.join('\n'),
			}
		}
		let unknown = build('Hello\n::: if $unknown == "true"\nDROPPED\n:::\nAfter')
		expect(unknown.problems).toMatch(/SYSTEM.md:2: unknown key unknown/)
		expect(unknown.text).toContain('Hello\nAfter')
		expect(unknown.text).not.toContain('DROPPED')
		let unclosed = build('Hello\n::: if $session_model like "*"\ntext')
		expect(unclosed.problems).toMatch(/SYSTEM.md:2: unclosed/)
		expect(unclosed.text).toContain('Hello\ntext')
	} finally {
		systemPrompt.file = old
	}
})

test('SYSTEM includes are templates resolved relative to their file', () => {
	let old = systemPrompt.file
	try {
		systemPrompt.file = () => `${root}/SYSTEM.md`
		mkdirSync(`${root}/more`)
		writeFileSync(`${root}/more/inner.md`, 'inner ${session_model}')
		writeFileSync(
			`${root}/more/part.md`,
			'<!-- note\nfor me -->::: if $session_model like "wrong/*"\nhidden\n:::\n@inner.md\n@?missing.md\n',
		)
		writeFileSync(`${root}/SYSTEM.md`, 'Hello\n@more/part.md\n@?absent.md')
		let text = systemPrompt.build({ cwd: root, model: 'm/x', now: at })
		expect(text).toContain('Hello\ninner m/x')
		expect(text).not.toContain('for me')
		expect(text).not.toContain('hidden')
		expect(text).not.toContain('@?')
		writeFileSync(`${root}/SYSTEM.md`, 'Before\n@missing.md\nAfter')
		let problems: string[] = []
		expect(systemPrompt.build({ cwd: root, model: 'm/x', now: at }, problems)).toContain('Before\nAfter')
		expect(problems.join()).toMatch(/SYSTEM.md:2: include: .*missing.md/)
	} finally {
		systemPrompt.file = old
	}
})

test('the home USER.md appears in the real SYSTEM prompt when present, with no residue when absent', () => {
	let old = paths.state.home
	try {
		paths.state.home = root
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
		if (old === undefined) paths.state.home = undefined
		else paths.state.home = old
	}
})

test('skills are listed by name: Hal and user skills always, project skills only along the cwd chain', () => {
	let skill = (dir: string) => (
		mkdirSync(dir, { recursive: true }),
		writeFileSync(`${dir}/SKILL.md`, '---\nname: x\n---\nBODY TEXT')
	)
	let userHome = paths.userHome
	paths.userHome = () => `${root}/user`
	try {
		skill(`${root}/user/.agents/skills/mine`)
		skill(`${root}/user/.claude/skills/claude-mine`)
		mkdirSync(`${root}/repo/.git`, { recursive: true })
		skill(`${root}/repo/.agents/skills/zeta`)
		skill(`${root}/repo/.agents/skills/alpha`)
		mkdirSync(`${root}/repo/.agents/skills/no-skill-file`)
		skill(`${root}/repo/sub/.claude/skills/inner`)
		skill(`${root}/repo/other/.agents/skills/elsewhere`)
		mkdirSync(`${root}/repo/sub/deep`, { recursive: true })
		writeFileSync(`${root}/repo/AGENTS.md`, 'PROJECT RULE')
		projectContext.decide(`${root}/repo`, true)
		let rendered = systemPrompt.inspect({ cwd: `${root}/repo/sub/deep`, model: 'm/x', now: at })
		let text = rendered.sections.find((s) => s.title === 'Skills')!.body
		let instructions = rendered.sections.find((s) => s.title === 'Local instructions')!.body
		expect(rendered.problems).toEqual([])
		expect(instructions).toContain('PROJECT RULE')
		expect(instructions).not.toContain('/skills/')
		expect(text).not.toContain('PROJECT RULE')
		expect(text).toMatch(
			new RegExp(
				`Skills - read <dir>/SKILL.md when appropriate: \\S+/skills/\\S*hal-server-install\\S* ${root}/user/.agents/skills/mine ${root}/user/.claude/skills/claude-mine ${root}/repo/.agents/skills/\\{alpha,zeta\\} ${root}/repo/sub/.claude/skills/inner$`,
			),
		)
		// Folders without SKILL.md, projects off the chain and skill bodies stay out.
		expect(text).not.toContain('no-skill-file')
		expect(text).not.toContain('elsewhere')
		expect(text).not.toContain('BODY TEXT')
		// Outside that project only the Hal and user skills remain.
		let away = systemPrompt.build({ cwd: root, model: 'm/x', now: at })
		expect(away).toMatch(/\/skills\/\S*hal-server-install/)
		expect(away).toContain(`${root}/user/.agents/skills/mine`)
		expect(away).not.toContain('alpha')
		// With the home as cwd, its skill folders are listed once.
		let atHome = systemPrompt.build({ cwd: `${root}/user`, model: 'm/x', now: at })
		expect(atHome.split('/user/.agents/skills/mine').length).toBe(2)
	} finally {
		paths.userHome = userHome
	}
})
