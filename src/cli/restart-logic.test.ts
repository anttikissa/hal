import { mock, test, expect, afterEach } from 'bun:test'

const mockHalStatus = { isHost: false }
let mockShutdownCalls = 0

// Mock main.ts to prevent TTY/IPC/CLI side effects
mock.module('../main.ts', () => ({
	halStatus: mockHalStatus,
	shutdown: async () => { mockShutdownCalls++ },
}))

// Switchable runtime mock — runtimeOrNull() uses require() so this intercepts it
let fakeRuntime: any = null
mock.module('../runtime/runtime.ts', () => ({
	getRuntime: () => {
		if (!fakeRuntime) throw new Error('no runtime')
		return fakeRuntime
	},
	runtimeCore: {
		getRuntime: () => {
			if (!fakeRuntime) throw new Error('no runtime')
			return fakeRuntime
		},
	},
}))

// Mock ipc to prevent file I/O from writeHandoff
mock.module('../ipc.ts', () => ({
	ipc: { updateState: () => {} },
}))

const { restartLogic } = await import('./restart-logic.ts')
const { terminal } = await import('./terminal.ts')

// Prevent real terminal manipulation
terminal.disableTerminalInput = () => {}

afterEach(() => {
	terminal.disableTerminalInput = () => {}
	mockHalStatus.isHost = false
	mockShutdownCalls = 0
	fakeRuntime = null
})

function makeDeps(overrides?: Record<string, any>): any {
	const deps: any = {
		saveDraftCalls: 0,
		client: {
			saveDraft: async () => { deps.saveDraftCalls++ },
			activeTab: () => null,
			getState: () => ({ tabs: [] }),
		},
		useKitty: false,
		getRenderState: () => ({ lines: [], cursorRow: 0 }),
		resetAndRender: () => {},
		doRender: () => {},
		...overrides,
	}
	return deps
}

test('quit calls saveDraft', async () => {
	const deps = makeDeps()
	restartLogic.init(deps)

	await restartLogic.quit()

	expect(deps.saveDraftCalls).toBe(1)
})

test('quit with destructive tools defers on first call', async () => {
	mockHalStatus.isHost = true
	fakeRuntime = { activeDestructiveTools: new Set(['t1']) }

	const blocks: any[] = []
	const deps = makeDeps({
		client: {
			saveDraft: async () => { deps.saveDraftCalls++ },
			activeTab: () => ({ blocks }),
			getState: () => ({ tabs: [] }),
		},
	})
	restartLogic.init(deps)

	await restartLogic.quit()

	// First call: deferred — destructive tools active
	expect(deps.saveDraftCalls).toBe(0)
	expect(blocks.some((b: any) => b.text?.includes('waiting for tool calls'))).toBe(true)

	// Second call: forced through
	await restartLogic.quit()
	expect(deps.saveDraftCalls).toBe(1)
})

test('restart calls saveDraft and exits 100', async () => {
	const deps = makeDeps()
	restartLogic.init(deps)

	const origExit = process.exit
	let exitCode: number | undefined
	process.exit = ((code?: number) => { exitCode = code }) as any

	await restartLogic.restart()

	expect(deps.saveDraftCalls).toBe(1)
	expect(exitCode).toBe(100)

	process.exit = origExit
})
