import { test, expect, beforeEach, mock } from 'bun:test'

// Stub cli.ts exports before importing keybindings
const sentCommands: { type: string; text?: string }[] = []
const pushBlocks: any[] = []

const mockClient = {
	send: mock(async (type: string, text?: string) => { sentCommands.push({ type, text }) }),
	onSubmit: mock((_t: string) => {}),
	activeTab: mock(() => ({ blocks: pushBlocks, sessionId: 'test', info: {}, busy: false, inputHistory: [], inputDraft: '', contentHeight: 0 })),
}

mock.module('../cli.ts', () => ({
	client: mockClient,
	quit: mock(() => {}),
	restart: mock(() => {}),
	suspend: mock(() => {}),
	doRender: mock(() => {}),
	contentWidth: mock(() => 80),
	showError: mock(() => {}),
}))

const { handleInput } = await import('./keybindings.ts')
const promptMod = await import('./prompt.ts')

function enter() {
	handleInput({ key: 'enter', ctrl: false, alt: false, shift: false, cmd: false })
}

beforeEach(() => {
	sentCommands.length = 0
	pushBlocks.length = 0
	promptMod.reset()
	mockClient.send.mockClear()
})

test('/help adds a local help block without sending a command', () => {
	promptMod.setText('/help')
	enter()
	expect(sentCommands).toEqual([])
	expect(pushBlocks.length).toBe(1)
	expect(pushBlocks[0].type).toBe('assistant')
	expect(pushBlocks[0].done).toBe(true)
	expect(pushBlocks[0].text).toContain('/reset')
	expect(pushBlocks[0].text).toContain('/model')
	expect(pushBlocks[0].text).toContain('/topic')
	expect(pushBlocks[0].text).toContain('ctrl-t')
})
