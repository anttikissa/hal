import { expect, test } from 'bun:test'
import { renderStatus } from './render-status.ts'
import { client } from '../app.ts'
import { clientBackend } from '../backend.ts'
import { promptEdit } from '../prompt-edit.ts'
import { visLen } from '../../utils/strings.ts'
import { blockText } from './block-text.ts'

function tab(overrides: any = {}): any {
	return {
		sessionId: '04-new',
		name: 'new',
		history: [],
		inputHistory: [],
		inputDraft: '',
		parentEntryCount: 0,
		loaded: true,
		doneUnseen: false,
		attention: undefined,
		historyVersion: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
		contextUsed: 0,
		contextMax: 0,
		cwd: '',
		model: '',
		...overrides,
	}
}


test('status identifies host, local peer, and remote client', () => {
	const original = client.state.role
	try {
		for (const role of ['host', 'peer', 'client'] as const) {
			client.state.role = role
			expect(renderStatus.serverStatusLabel()).toBe(role)
		}
	} finally {
		client.state.role = original
	}
})

test('subscriptionStatusLabel renders normalized subscription windows', () => {
	const current = clientBackend.subscriptions.current
	try {
		clientBackend.subscriptions.current = () => ({ index: 0, total: 1, windows: [{ label: '7d', usedPercent: 24 }] })

		const label = renderStatus.subscriptionStatusLabel('openai', '')

		expect(label).toContain('7d')
		expect(label).not.toContain('5h')
	} finally {
		clientBackend.subscriptions.current = current
	}
})

test('tabIndicator shows amber diamond for new attention marker', () => {
	const origWorking = client.state.working
	client.state.working = new Map()
	try {
		const indicator = renderStatus.tabIndicator(tab({ attention: 'new' }))
		expect(indicator.char).toBe('◆')
		expect(indicator.blinks).toBe(false)
	} finally {
		client.state.working = origWorking
	}
})

test('tabIndicator shows blinking amber diamond for new working tab', () => {
	const origWorking = client.state.working
	client.state.working = new Map([['04-new', true]])
	try {
		const indicator = renderStatus.tabIndicator(tab({ attention: 'new' }))
		expect(indicator.char).toBe('◆')
		expect(indicator.blinks).toBe(true)
	} finally {
		client.state.working = origWorking
	}
})


test('tabIndicator uses the server continuation action instead of error blocks', () => {
	const failed = tab({ history: [{ type: 'error', text: 'provider error' }] })
	expect(renderStatus.tabIndicator(failed).char).toBe('')
	failed.continuation = 'retry'
	expect(renderStatus.tabIndicator(failed).char).toBe('✗')
})

test('activityStatusLabel names visible working phases', () => {
	const origWorking = client.state.working
	const origToolConfirm = client.state.toolConfirmPending
	client.state.working = new Map([['04-new', true]])
	client.state.toolConfirmPending = new Set()
	try {
		expect(renderStatus.activityStatusLabel(tab())).toBe('processing')
		expect(renderStatus.activityStatusLabel(tab({ history: [{ type: 'thinking', text: 'reasoning', streaming: true }] }))).toBe('thinking')
		expect(renderStatus.activityStatusLabel(tab({ history: [{ type: 'assistant', text: 'hi', streaming: true }] }))).toBe('writing')
		expect(renderStatus.activityStatusLabel(tab({ history: [{ type: 'tool', name: 'bash', output: 'first line', running: true }] }))).toBe('running bash')
		expect(renderStatus.activityStatusLabel(tab({ history: [
			{ type: 'tool', name: 'bash', output: 'first line', running: true },
			{ type: 'tool', name: 'eval', output: 'second line', running: true },
		] }))).toBe('running 2 tools')
		client.state.toolConfirmPending.add('04-new')
		expect(renderStatus.activityStatusLabel(tab())).toBe('waiting for approval')
	} finally {
		client.state.working = origWorking
		client.state.toolConfirmPending = origToolConfirm
	}
})

test('activityStatusLabel clears after final assistant text while turn cleanup is pending', () => {
	const origWorking = client.state.working
	client.state.working = new Map([['04-new', true]])
	try {
		expect(renderStatus.activityStatusLabel(tab({ history: [{ type: 'assistant', text: 'done', streaming: false }] }))).toBe('')
	} finally {
		client.state.working = origWorking
	}
})

test('activityStatusLabel describes a prompt edit while its turn is pausing or paused', () => {
	const origWorking = client.state.working
	client.state.working = new Map([['04-new', true]])
	promptEdit.start({ sessionId: '04-new', mode: 'amend', originalText: 'original prompt', pausedWorkingTurn: true })
	try {
		expect(renderStatus.activityStatusLabel(tab({ history: [{ type: 'thinking', text: 'hmm', streaming: true }] }))).toBe('editing current prompt · pausing')
		client.state.working = new Map()
		expect(renderStatus.activityStatusLabel(tab())).toBe('editing current prompt · paused')
	} finally {
		promptEdit.cancel()
		client.state.working = origWorking
	}
})

test('activityStatusLabel identifies an idle continuable turn as paused', () => {
	expect(renderStatus.activityStatusLabel(tab({ continuation: 'continue' }))).toBe('paused')
})


test('activityStatusLabel combines working and summarizing', () => {
	const origWorking = client.state.working
	const origSummarizing = client.state.summarizing
	client.state.working = new Map([['04-new', true]])
	client.state.summarizing = new Set(['04-new'])
	try {
		expect(renderStatus.activityStatusLabel(tab({ history: [{ type: 'assistant', text: 'hi', streaming: true }] }))).toBe('writing · summarizing')
	} finally {
		client.state.working = origWorking
		client.state.summarizing = origSummarizing
	}
})

test('buildTabText compact mode separates tabs with one space and underlines the active tab instead of bracketing it', () => {
	const origTabs = client.state.tabs.slice()
	const origFocused = client.state.focusedTabIndex
	client.state.tabs.length = 0
	client.state.tabs.push(tab({ sessionId: 'a' }), tab({ sessionId: 'b' }), tab({ sessionId: 'c' }))
	client.state.focusedTabIndex = 1
	try {
		const compact = renderStatus.buildTabText(true)
		expect(blockText.stripAnsiSequences(compact)).toBe('1 2 3')
		expect(compact).toContain('\x1b[4m2\x1b[24m')
	} finally {
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.focusedTabIndex = origFocused
	}
})

test('buildTabBarLines switches to compact mode when even the bare tab numbers overflow the width', () => {
	const origTabs = client.state.tabs.slice()
	const origFocused = client.state.focusedTabIndex
	client.state.tabs.length = 0
	for (let i = 0; i < 40; i++) client.state.tabs.push(tab({ sessionId: `s${i}` }))
	client.state.focusedTabIndex = 30
	try {
		const [line] = renderStatus.buildTabBarLines(80)
		expect(visLen(line!)).toBeLessThanOrEqual(80)
	} finally {
		client.state.tabs.length = 0

		client.state.tabs.push(...origTabs)
		client.state.focusedTabIndex = origFocused
	}
})


test('zero opacity hides chrome content without changing its row count', () => {
	const original = {
		tabs: renderStatus.config.tabsOpacity,
		prompt: renderStatus.config.promptOpacity,
		status: renderStatus.config.statusOpacity,
		help: renderStatus.config.helpOpacity,
	}
	try {
		renderStatus.config.tabsOpacity = 0
		renderStatus.config.promptOpacity = 0
		renderStatus.config.statusOpacity = 0
		renderStatus.config.helpOpacity = 0
		const lines: string[] = []
		renderStatus.renderTabBar(lines)
		renderStatus.renderPrompt(lines)
		renderStatus.renderStatusLine(lines)
		renderStatus.renderHelpBar(lines)
		expect(lines).toHaveLength(renderStatus.chromeLines())
		for (const line of lines) expect(blockText.stripAnsiSequences(line).trim()).toBe('')
	} finally {
		renderStatus.config.tabsOpacity = original.tabs
		renderStatus.config.promptOpacity = original.prompt
		renderStatus.config.statusOpacity = original.status
		renderStatus.config.helpOpacity = original.help
	}
})
