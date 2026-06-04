import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ipc } from '../ipc.ts'
import { sessions as sessionStore } from '../server/sessions.ts'
import { completion } from './completion.ts'

const origReadState = ipc.readState
const origLoadAllSessionMetas = sessionStore.loadAllSessionMetas

afterEach(() => {
	ipc.readState = origReadState
	sessionStore.loadAllSessionMetas = origLoadAllSessionMetas
})

test('/config completes as a command name', () => {
	const result = completion.complete('/con', '/con'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/config')
})


test('/keys completes as a terminal-local command name', () => {
	const result = completion.complete('/k', '/k'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/keys')
})

test('/exi completes to /exit', () => {
	const result = completion.complete('/exi', '/exi'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/exit')
	expect(result!.prefix).toBe('/exit')
})

test('/help completes command names', () => {
	const result = completion.complete('/help co', '/help co'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/help config')
})


test('/st completes to /status', () => {
	const result = completion.complete('/st', '/st'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/status')
})

test('/help st completes command names from runtime command list', () => {
	const result = completion.complete('/help st', '/help st'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/help status')
})


test('/go completes session ids and names but not tab numbers', () => {
	ipc.readState = () => ({
		sessions: [
			{ id: '04-one', tab: 1, name: 'main', cwd: '/tmp/main' },
			{ id: '04-two', tab: 2, name: 'pause fix', cwd: '/tmp/pause' },
		],
		busy: {},
		activity: {},
		working: {},
		updatedAt: new Date().toISOString(),
	})
	sessionStore.loadAllSessionMetas = () => [
		{ id: '04-one', name: 'main', workingDir: '/tmp/main', createdAt: '2026-01-01T00:00:00.000Z' },
		{ id: '04-old', name: 'old work', workingDir: '/tmp/old', createdAt: '2026-01-01T00:00:00.000Z', closedAt: '2026-01-01T01:00:00.000Z' },
	]

	const id = completion.complete('/go 04-', '/go 04-'.length)
	const name = completion.complete('/go pause ', '/go pause '.length)
	const closedName = completion.complete('/go old', '/go old'.length)
	const empty = completion.complete('/go ', '/go '.length)

	expect(id!.items).toContain('/go 04-two')
	expect(id!.items).toContain('/go 04-old')
	expect(name!.items).toEqual(['/go pause fix'])
	expect(closedName!.items).toEqual(['/go old work'])
	expect(empty!.items).not.toContain('/go 1')
	expect(empty!.items).not.toContain('/go 2')
})


test('/login completes provider names', () => {
	const result = completion.complete('/login a', '/login a'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toEqual(['/login anthropic'])
})


test('/model completes model arguments like opus without crashing', () => {
	const result = completion.complete('/model opus', '/model opus'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/model opus')
})


test('/model completes current model aliases and bare model ids', () => {
	const alias = completion.complete('/model gemini', '/model gemini'.length)
	const bare = completion.complete('/model gemini-3.5-f', '/model gemini-3.5-f'.length)

	expect(alias).not.toBeNull()
	expect(alias!.items).toContain('/model gemini')
	expect(alias!.items).toContain('/model gemini-3.5-flash')
	expect(bare).not.toBeNull()
	expect(bare!.items).toContain('/model gemini-3.5-flash')
})


test('/config completes module names', () => {
	const result = completion.complete('/config mod', '/config mod'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/config models')
})

test('/config completes nested config paths', () => {
	const result = completion.complete('/config models.def', '/config models.def'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/config models.default')
})


test('/cd completes directories from the focused session cwd', () => {
	const root = mkdtempSync(join(tmpdir(), 'hal-complete-cd-'))
	try {
		mkdirSync(join(root, 'alpha'))
		mkdirSync(join(root, 'beta'))

		const result = completion.complete('/cd a', '/cd a'.length, root)

		expect(result).not.toBeNull()
		expect(result!.items).toEqual(['/cd alpha/'])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})


test('/cd completes paths whose prefix contains spaces', () => {
	const root = mkdtempSync(join(tmpdir(), 'hal-complete-cd-spaces-'))
	try {
		mkdirSync(join(root, 'Mobile Documents'))

		const result = completion.complete('/cd Mobile ', '/cd Mobile '.length, root)

		expect(result).not.toBeNull()
		expect(result!.items).toEqual(['/cd Mobile Documents/'])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
