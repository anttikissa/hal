import { expect, test } from 'bun:test'
import { renderStatus } from './render-status.ts'
import { client } from '../client.ts'

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
