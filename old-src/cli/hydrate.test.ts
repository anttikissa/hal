import { describe, test, expect } from 'bun:test'
import { write, clearOutput, getOutputSnapshot } from './tui.ts'
import { applyHydratedOutput } from './client.ts'

describe('applyHydratedOutput', () => {
	test('preserves live content rendered since bootstrap', () => {
		clearOutput()
		// Live content rendered between bootstrapTabs() and hydrateHistory() completing
		write('[perf] startup: 80ms\n')
		write('[session] restored 42 messages\n')

		// Hydration completes — should merge, not wipe
		applyHydratedOutput('<assistant> Previous response</assistant>\n')

		const output = getOutputSnapshot()
		expect(output).toContain('Previous response')
		expect(output).toContain('[perf] startup')
		expect(output).toContain('[session] restored')
	})
})
