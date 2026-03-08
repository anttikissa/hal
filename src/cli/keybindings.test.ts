import { test, expect, beforeEach, mock } from 'bun:test'

// Stub cli.ts exports before importing keybindings
const sentCommands: { type: string; text?: string }[] = []
const pushBlocks: any[] = []

const mockClient = {
	send: mock(async (type: string, text?: string) => { sentCommands.push({ type, text }) }),
	onSubmit: mock((_t: string) => {}),
	activeTab: mock(() => ({ blocks: pushBlocks, sessionId: 'test', info: {}, busy: false, pausing: false, inputHistory: [], inputDraft: '', contentHeight: 0 })),
	markPausing: mock(() => {}),
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
	mockClient.markPausing.mockClear()
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

test('option+digit switches to tab N (1-indexed)', () => {
	const switchToTab = mock(() => {})
	;(mockClient as any).switchToTab = switchToTab
	handleInput({ key: '3', ctrl: false, alt: true, shift: false, cmd: false })
	expect(switchToTab).toHaveBeenCalledWith(2) // 0-indexed
})

test('option+digit does not switch on non-digit', () => {
	const switchToTab = mock(() => {})
	;(mockClient as any).switchToTab = switchToTab
	handleInput({ key: 'g', ctrl: false, alt: true, shift: false, cmd: false })
	expect(switchToTab).not.toHaveBeenCalled()
})

test('escape sends pause and calls markPausing when active tab is busy', () => {
	mockClient.activeTab.mockReturnValueOnce({ blocks: pushBlocks, sessionId: 'test', info: {}, busy: true, pausing: false, inputHistory: [], inputDraft: '', contentHeight: 0 })
	handleInput({ key: 'escape', ctrl: false, alt: false, shift: false, cmd: false })
	expect(sentCommands).toEqual([{ type: 'pause', text: undefined }])
	expect(mockClient.markPausing).toHaveBeenCalledTimes(1)
})

test('escape does nothing when active tab is not busy', () => {
	handleInput({ key: 'escape', ctrl: false, alt: false, shift: false, cmd: false })
	expect(sentCommands).toEqual([])
})