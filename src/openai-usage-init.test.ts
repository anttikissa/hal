import { expect, test } from 'bun:test'
import { openaiUsage } from './openai-usage.ts'
import { liveFiles } from './utils/live-file.ts'

test('openaiUsage.init loads lazily and only once', () => {
	const runtime = (openaiUsage as any).runtime
	if (!runtime || typeof openaiUsage.init !== 'function') throw new Error('openaiUsage.init() is required')

	const origInitialized = runtime.initialized
	const origState = openaiUsage.state
	const origLiveFile = liveFiles.liveFile
	let liveFileCalls = 0

	liveFiles.liveFile = ((path: string, defaults: Record<string, any>) => {
		liveFileCalls++
		expect(path.endsWith('/openai-usage.ason')).toBe(true)
		expect(defaults).toMatchObject({ currentKey: '', lastActiveAt: '', updatedAt: '', accounts: {} })
		return { currentKey: '', lastActiveAt: '', updatedAt: '', accounts: {} } as any
	}) as typeof liveFiles.liveFile

	try {
		runtime.initialized = false
		openaiUsage.state = { currentKey: '', lastActiveAt: '', updatedAt: '', accounts: {} }
		expect(liveFileCalls).toBe(0)

		openaiUsage.init()
		expect(runtime.initialized).toBe(true)
		expect(liveFileCalls).toBe(1)

		openaiUsage.init()
		expect(liveFileCalls).toBe(1)
	} finally {
		runtime.initialized = origInitialized
		openaiUsage.state = origState
		liveFiles.liveFile = origLiveFile
	}
})
