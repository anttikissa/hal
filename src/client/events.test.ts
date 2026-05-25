import { afterEach, expect, test } from 'bun:test'
import { client } from '../client.ts'

function makeTab(): any {
	return {
		sessionId: 's1',
		name: 's1',
		history: [],
		inputHistory: [],
		inputDraft: '',
		parentEntryCount: 0,
		liveHistory: [],
		loaded: true,
		doneUnseen: false,
		historyVersion: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
		contextUsed: 0,
		contextMax: 0,
		cwd: '/tmp',
		model: 'openai/gpt-5.5',
	}
}

afterEach(() => {
	client.state.tabs.length = 0
	client.state.activeTab = 0
	client.resetForTests()
})

test('prompt events do not duplicate a prompt already loaded from rebased history', () => {
	const tab = makeTab()
	tab.history.push({ type: 'user', text: 'same prompt', ts: Date.now() })
	client.state.tabs.push(tab)

	client.handleEvent({ type: 'prompt', sessionId: 's1', text: 'same prompt', createdAt: new Date().toISOString() })

	expect(tab.history.filter((block: any) => block.type === 'user' && block.text === 'same prompt')).toHaveLength(1)
})
