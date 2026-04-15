import { expect, test } from 'bun:test'
import { colors } from './colors.ts'
import { liveFiles } from '../utils/live-file.ts'

test('colors.init loads lazily and only once', () => {
	const state = (colors as any).state
	if (!state || typeof colors.init !== 'function') throw new Error('colors.init() is required')

	const origInitialized = state.initialized
	const origWatcher = state.watcher
	const origLiveFile = liveFiles.liveFile
	const origOnChange = liveFiles.onChange
	let liveFileCalls = 0
	let onChangeCalls = 0

	liveFiles.liveFile = ((path: string, defaults: Record<string, any>, opts?: { watch?: boolean }) => {
		liveFileCalls++
		expect(path.endsWith('/colors.ason')).toBe(true)
		expect(defaults).toEqual({})
		expect(opts).toEqual({ watch: true })
		return { watched: true } as any
	}) as typeof liveFiles.liveFile
	liveFiles.onChange = ((watcher: object, cb: () => void) => {
		onChangeCalls++
		expect(watcher).toEqual({ watched: true })
		expect(typeof cb).toBe('function')
	}) as typeof liveFiles.onChange

	try {
		state.initialized = false
		state.watcher = null
		expect(liveFileCalls).toBe(0)
		expect(onChangeCalls).toBe(0)

		colors.init()
		expect(state.initialized).toBe(true)
		expect(liveFileCalls).toBe(1)
		expect(onChangeCalls).toBe(1)

		colors.init()
		expect(liveFileCalls).toBe(1)
		expect(onChangeCalls).toBe(1)
	} finally {
		state.initialized = origInitialized
		state.watcher = origWatcher
		liveFiles.liveFile = origLiveFile
		liveFiles.onChange = origOnChange
	}
})
