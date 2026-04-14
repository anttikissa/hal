import { expect, test } from 'bun:test'
import { config } from './config.ts'
import { liveFiles } from './utils/live-file.ts'
import { models } from './models.ts'

test('config.init loads config lazily and only once', () => {
	const origInitialized = (config as any).state?.initialized
	const origData = config.data
	const origLiveFile = liveFiles.liveFile
	const origOnChange = liveFiles.onChange
	const origDefaultModel = models.config.default
	const loadedData = { models: { default: 'gpt' } } as Record<string, any>
	let liveFileCalls = 0
	let onChangeCalls = 0

	liveFiles.liveFile = ((path: string) => {
		liveFileCalls++
		expect(path.endsWith('/config.ason')).toBe(true)
		return loadedData
	}) as typeof liveFiles.liveFile
	liveFiles.onChange = ((data: object) => {
		onChangeCalls++
		expect(data).toBe(loadedData)
	}) as typeof liveFiles.onChange

	try {
		expect((config as any).state?.initialized).toBe(false)
		expect(liveFileCalls).toBe(0)
		expect(onChangeCalls).toBe(0)

		config.init()
		expect((config as any).state?.initialized).toBe(true)
		expect(config.data).toBe(loadedData)
		expect(models.config.default).toBe('gpt')
		expect(liveFileCalls).toBe(1)
		expect(onChangeCalls).toBe(1)

		config.init()
		expect(liveFileCalls).toBe(1)
		expect(onChangeCalls).toBe(1)
	} finally {
		if ((config as any).state) (config as any).state.initialized = origInitialized ?? false
		config.data = origData
		liveFiles.liveFile = origLiveFile
		liveFiles.onChange = origOnChange
		models.config.default = origDefaultModel
	}
})
