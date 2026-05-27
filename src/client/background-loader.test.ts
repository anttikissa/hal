import { expect, test } from 'bun:test'
import { backgroundLoader } from './background-loader.ts'

function ctx(calls: string[], showStartupPerf = false) {
	return {
		config: { backgroundLoadBlobs: false, backgroundLoadTabs: true, showStartupPerf },
		tabs: [{ loaded: true, history: [] }, { loaded: false, history: [] }],
		activeTab: () => 0,
		ensureTabLoaded: () => { calls.push('load background tab') },
		touchTab: () => {},
		onChange: () => {},
		showStartupSummary: () => { calls.push('startup summary') },
	}
}

test('shows startup summary before loading background tabs', async () => {
	const calls: string[] = []
	await backgroundLoader.load(ctx(calls))
	expect(calls).toEqual(['startup summary', 'load background tab'])
})

test('defers startup summary until after background tabs when startup perf is enabled', async () => {
	const calls: string[] = []
	await backgroundLoader.load(ctx(calls, true))

	expect(calls).toEqual(['load background tab', 'startup summary'])
})
