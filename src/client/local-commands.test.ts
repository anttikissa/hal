import { expect, test } from 'bun:test'
import { clientLocalCommands, type ClientLocalCommandContext } from './local-commands.ts'

function ctx(): ClientLocalCommandContext {
	return {
		tabs: [
			{ sessionId: '04-one', name: 'main' },
			{ sessionId: '04-two', name: 'pause fix' },
			{ sessionId: '04-three', name: 'docs' },
		],
		activeTab: 0,
		switchTab(index: number) {
			this.activeTab = index
		},
		sendCommand() {},
	}
}

test('/go switches by tab number locally', () => {
	const c = ctx()
	const result = clientLocalCommands.execute('/go 2', c)

	expect(result).toMatchObject({ handled: true, output: 'Switched to tab 2: pause fix' })
	expect(c.activeTab).toBe(1)
})

test('/go switches by partial tab name', () => {
	const c = ctx()
	const result = clientLocalCommands.execute('/go pause', c)

	expect(result).toMatchObject({ handled: true, output: 'Switched to tab 2: pause fix' })
	expect(c.activeTab).toBe(1)
})

test('/go reports ambiguous partial tab names', () => {
	const c = ctx()
	c.tabs.push({ sessionId: '04-four', name: 'pause docs' })
	const result = clientLocalCommands.execute('/go pause', c)

	expect(result.handled).toBe(true)
	expect(result.error).toContain('Ambiguous')
	expect(result.error).toContain('pause fix')
	expect(result.error).toContain('pause docs')
	expect(c.activeTab).toBe(0)
})

test('/quit quits with a visible goodbye', () => {
	const result = clientLocalCommands.execute('/quit', ctx())

	expect(result).toMatchObject({ handled: true, output: 'Goodbye.', quit: true })
})

test('/exit is a silent local alias for /quit', () => {
	const result = clientLocalCommands.execute('/exit', ctx())

	expect(result).toMatchObject({ handled: true, quit: true })
	expect(result.output).toBeUndefined()
	expect(clientLocalCommands.commandNames()).toContain('quit')
	expect(clientLocalCommands.commandNames()).not.toContain('exit')
	expect(clientLocalCommands.commandNames(true)).toContain('exit')
})

test('/help includes terminal-local commands and shortcut hint', () => {
	const result = clientLocalCommands.execute('/help', ctx())

	expect(result.handled).toBe(true)
	expect(result.output).toContain('/go')
	expect(result.output).toContain('/keys')
	expect(result.output).toContain('/quit')
	expect(result.output).not.toContain('/exit')
	expect(result.output).toContain('/go <target>')
	expect(result.output).toContain('/help [<command>]')
	expect(result.output).toContain('Keyboard shortcuts')
})
