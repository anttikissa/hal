import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { completion } from './completion.ts'

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


test('/cd completes directories from the active session cwd', () => {
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
