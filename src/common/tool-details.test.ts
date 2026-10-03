import { expect, test } from 'bun:test'
import { toolDetails } from './tool-details.ts'

test('bash reads like the terminal; odd arguments show once, plumbing never', () => {
	let input = { command: 'cat <<EOF\nhi\nEOF', description: 'Say hi', modifies: ['a.ts', 'src/*.ts'], background: true, timeout: 600_000, extra: 'x' }
	expect(toolDetails.lines('bash', input)).toEqual(['& cat <<EOF', '  hi', '  EOF', 'Edits a.ts, src/*.ts', 'extra: x'])
	expect(toolDetails.lines('bash', { command: 'ls', description: 'List', timeout: 5000, background: 'yes' })).toEqual(['$ ls', 'Timeout 5 s', 'background: yes'])
	expect(toolDetails.headline('notify', { text: 'Done' })).toEqual({ text: 'Notify "Done"', key: 'text' })
	expect(toolDetails.lines('notify', { text: 'Done' })).toEqual([])
})

test('inspect heads with every argument once; unknown ones still show', () => {
	expect(toolDetails.headline('inspect', { scope: 'self', fields: 'id,model,context' }).text).toBe('Inspect self (id, model, context)')
	expect(toolDetails.headline('inspect', { what: 'host' }).text).toBe('Inspect host')
	expect(toolDetails.lines('inspect', { scope: 'all', fields: 'tab', extra: 1 })).toEqual(['extra: 1'])
})

test('spawn and wait name the sessions their result reports', () => {
	let h = (name: string, input: Record<string, unknown>, out?: string) => toolDetails.headline(name, input, out).text
	expect(h('spawn', { name: 'v3 UI craft pass', task: 't' }, 'Started tab 3 · 31-swe · v3 UI craft pass. Its last message comes back here')).toBe('Spawn "v3 UI craft pass" (tab 3, 31-swe)')
	expect(h('spawn', { kind: 'interactive' }, 'Opened tab 4 · 31-sit for the user.')).toBe('Spawn interactive session (tab 4, 31-sit)')
	expect(h('wait', {}, 'Waiting for tab 3 · 31-swe · Pass, one, tab 5 · 31-bux. This turn ends here')).toBe('Wait for 31-swe, 31-bux')
	expect(h('bash', { command: 'serve', description: 'Start server', background: true })).toBe('Start server (background)')
})
