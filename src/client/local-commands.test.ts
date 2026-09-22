import { expect, test } from 'bun:test'
import { clientLocalCommands, type ClientLocalCommandContext } from './local-commands.ts'
import { perf } from './perf.ts'

function ctx(): ClientLocalCommandContext {
	return {
		tabs: [
			{ sessionId: '04-one', name: 'main' },
			{ sessionId: '04-two', name: 'pause fix' },
			{ sessionId: '04-three', name: 'docs' },
		],
		focusedTabIndex: 0,
		switchTab(index: number) {
			this.focusedTabIndex = index
		},
		sendCommand() {},
	}
}

test('/what sends non-interrupting what command with target text', () => {
	const c = ctx()
	const sent: any[] = []
	c.sendCommand = (type, text) => { sent.push({ type, text }) }
	const result = clientLocalCommands.execute('/what 5-9', c)

	expect(result).toEqual({ handled: true })
	expect(sent).toEqual([{ type: 'what', text: '5-9' }])
})

test('/what defaults to current session target', () => {
	const c = ctx()
	const sent: any[] = []
	c.sendCommand = (type, text) => { sent.push({ type, text }) }
	clientLocalCommands.execute('/what', c)

	expect(sent).toEqual([{ type: 'what', text: '' }])
})

test('/help includes terminal-local commands and shortcut hint', () => {
	const result = clientLocalCommands.execute('/help', ctx())

	expect(result.handled).toBe(true)
	expect(result.output).toContain('/go')
	expect(result.output).toContain('/keys')
	expect(result.output).toContain('/quit')
	expect(result.output).toContain('/exit')
	expect(result.output).toContain('/go <target>')
	expect(result.output).toContain('/help [<command>]')
	expect(result.output).toContain('Keyboard shortcuts')
})
