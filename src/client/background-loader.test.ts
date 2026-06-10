import { expect, test } from 'bun:test'
import { backgroundLoader } from './background-loader.ts'

function ctx(calls: string[]) {
	return {
		config: { backgroundLoadBlobs: false, backgroundLoadTabs: true },
		tabs: [{ loaded: true, history: [] }, { loaded: false, history: [] }],
		focusedTabIndex: () => 0,
		ensureTabLoaded: () => { calls.push('load background tab') },
		touchTab: () => {},
		onChange: () => {},
	}
}

test('loads background tabs', async () => {
	const calls: string[] = []
	await backgroundLoader.load(ctx(calls))
	expect(calls).toEqual(['load background tab'])
})
