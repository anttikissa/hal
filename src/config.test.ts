import { expect, test } from 'bun:test'
import { config } from './config.ts'
import { liveFiles } from './utils/live-file.ts'
import { models } from './models.ts'
import { client } from './client.ts'
import { render } from './client/render.ts'

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

test('config.writePath rejects keys not declared by module config', () => {
	const origInitialized = config.state.initialized
	const origData = config.data
	const key = '__halTestUnknownKey'
	const hadKey = key in models.config
	const origKey = (models.config as Record<string, any>)[key]

	try {
		config.state.initialized = true
		config.data = { models: { default: 'gpt' } }

		const persisted = config.writePath(`models.${key}`, 123)
		expect(persisted.error).toBe(`Unknown config key: models.${key}`)
		expect((config.data.models as Record<string, any>)[key]).toBeUndefined()
		expect((models.config as Record<string, any>)[key]).toBeUndefined()

		const temp = config.writePath(`models.${key}`, 123, { temp: true })
		expect(temp.error).toBe(`Unknown config key: models.${key}`)
		expect((models.config as Record<string, any>)[key]).toBeUndefined()
	} finally {
		config.state.initialized = origInitialized
		config.data = origData
		if (hadKey) (models.config as Record<string, any>)[key] = origKey
		else delete (models.config as Record<string, any>)[key]
	}
})

test('config.formatReloadMessage describes changed added and removed keys', () => {
	const previous = {
		models: { default: 'opus', aliases: ['a'] },
		agentLoop: { maxIterations: 50 },
		memory: { warnRssMb: 1024 },
	}
	const next = {
		models: { default: 'gpt-5.5', aliases: ['a'] },
		agentLoop: { maxIterations: 80 },
		renderStatus: { showCost: false },
	}

	expect(config.formatReloadMessage(previous, next)).toBe("config.ason reloaded: agentLoop.maxIterations: 50 → 80; memory removed: { warnRssMb: 1024 }; models.default: 'opus' → 'gpt-5.5'; renderStatus added: { showCost: false }")
})

test('config.formatReloadMessage caps long change lists', () => {
	const previous: Record<string, any> = {}
	const next: Record<string, any> = {}
	for (let i = 0; i < 10; i++) next[`k${i}`] = i

	const message = config.formatReloadMessage(previous, next)
	expect(message).toContain('k0 added: 0')
	expect(message).toContain('(+2 more)')
})

test('config reload callback prints changed keys into current tab', () => {
	const origInitialized = config.state.initialized
	const origData = config.data
	const origLiveFile = liveFiles.liveFile
	const origOnChange = liveFiles.onChange
	const origAddEntry = client.addEntry
	const origRequestRender = client.requestRender
	const origInvalidate = render.invalidateHistoryCache
	const origDefaultModel = models.config.default
	const loadedData = { models: { default: 'opus' } } as Record<string, any>
	type ReloadCallback = (change: { path: string; previous: Record<string, any>; next: Record<string, any> }) => void
	let reload: ReloadCallback = () => { throw new Error('reload callback not registered') }
	let message = ''
	let invalidated = false
	let requestedRender = false

	liveFiles.liveFile = (() => loadedData) as typeof liveFiles.liveFile
	liveFiles.onChange = ((data: object, cb: typeof reload) => {
		expect(data).toBe(loadedData)
		reload = cb
	}) as typeof liveFiles.onChange
	client.addEntry = ((text: string) => {
		message = text
	}) as typeof client.addEntry
	client.requestRender = (() => {
		requestedRender = true
	}) as typeof client.requestRender
	render.invalidateHistoryCache = (() => {
		invalidated = true
	}) as typeof render.invalidateHistoryCache

	try {
		config.state.initialized = false
		config.init()
		loadedData.models.default = 'gpt-5.5'
		reload({ path: '/tmp/config.ason', previous: { models: { default: 'opus' } }, next: { models: { default: 'gpt-5.5' } } })

		expect(models.config.default).toBe('gpt-5.5')
		expect(invalidated).toBe(true)
		expect(requestedRender).toBe(false)
		expect(message).toBe("config.ason reloaded: models.default: 'opus' → 'gpt-5.5'")
	} finally {
		config.state.initialized = origInitialized
		config.data = origData
		liveFiles.liveFile = origLiveFile
		liveFiles.onChange = origOnChange
		client.addEntry = origAddEntry
		client.requestRender = origRequestRender
		render.invalidateHistoryCache = origInvalidate
		models.config.default = origDefaultModel
	}
})
