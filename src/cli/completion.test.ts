import { expect, test } from 'bun:test'
import { completion } from './completion.ts'

test('/config completes as a command name', () => {
	const result = completion.complete('/con', '/con'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/config')
})

test('/help completes command topics', () => {
	const result = completion.complete('/help co', '/help co'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/help config')
})


test('/st completes to /status', () => {
	const result = completion.complete('/st', '/st'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/status')
})

test('/help st completes command topics from runtime command list', () => {
	const result = completion.complete('/help st', '/help st'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/help status')
})


test('/model completes model arguments like opus without crashing', () => {
	const result = completion.complete('/model opus', '/model opus'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/model opus')
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
