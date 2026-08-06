import { expect, test } from 'bun:test'
import { renderStatus } from './render-status.ts'
import { client } from '../client.ts'
import { openaiUsage } from '../openai-usage.ts'
import { promptEdit } from './prompt-edit.ts'

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

test('subscriptionStatusLabel labels OpenAI windows from their returned duration', () => {
	openaiUsage.init()
	const currentKey = openaiUsage.state.currentKey
	const accounts = openaiUsage.state.accounts
	try {
		openaiUsage.state.currentKey = 'openai:0'
		openaiUsage.state.accounts = {
			'openai:0': {
				key: 'openai:0',
				index: 0,
				total: 1,
				pendingTokens: 0,
				primary: { usedPercent: 24, windowMinutes: 10_080, resetAt: 1 },
			},
		}

		const label = renderStatus.subscriptionStatusLabel('openai', '')

		expect(label).toContain('7d')
		expect(label).not.toContain('5h')
	} finally {
		openaiUsage.state.currentKey = currentKey
		openaiUsage.state.accounts = accounts
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

test('activityStatusLabel names visible working phases', () => {
	const origWorking = client.state.working
	const origToolConfirm = client.state.toolConfirmPending
	client.state.working = new Map([['04-new', true]])
	client.state.toolConfirmPending = new Set()
	try {
		expect(renderStatus.activityStatusLabel(tab())).toBe('processing')
		expect(renderStatus.activityStatusLabel(tab({ history: [{ type: 'thinking', text: 'reasoning', streaming: true }] }))).toBe('thinking')
		expect(renderStatus.activityStatusLabel(tab({ history: [{ type: 'assistant', text: 'hi', streaming: true }] }))).toBe('writing')
		expect(renderStatus.activityStatusLabel(tab({ history: [{ type: 'tool', name: 'bash' }] }))).toBe('running bash')
		client.state.toolConfirmPending.add('04-new')
		expect(renderStatus.activityStatusLabel(tab())).toBe('waiting for approval')
	} finally {
		client.state.working = origWorking
		client.state.toolConfirmPending = origToolConfirm
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
	const origWorking = client.state.working
	client.state.working = new Map()
	try {
		expect(renderStatus.activityStatusLabel(tab({ history: [{ type: 'log', text: '[paused]' }] }))).toBe('paused')
	} finally {
		client.state.working = origWorking
	}
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
