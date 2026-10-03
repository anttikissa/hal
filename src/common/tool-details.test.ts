import { expect, test } from 'bun:test'
import { toolDetails } from './tool-details.ts'

test('bash reads like the terminal; odd arguments show once, plumbing never', () => {
	let input = { command: 'cat <<EOF\nhi\nEOF', description: 'Say hi', modifies: ['a.ts', 'src/*.ts'], background: true, timeout: 600_000, extra: 'x' }
	expect(toolDetails.lines('bash', input)).toEqual(['& cat <<EOF', '  hi', '  EOF', 'Edits a.ts, src/*.ts', 'extra: x'])
	expect(toolDetails.lines('bash', { command: 'ls', description: 'List', timeout: 5000, background: 'yes' })).toEqual(['$ ls', 'Timeout 5 s', 'background: yes'])
	expect(toolDetails.headline('notify', { text: 'Done' })).toEqual({ text: 'notify: Done', key: 'text' })
	expect(toolDetails.lines('notify', { text: 'Done' })).toEqual([])
})

test('inspect heads with every argument once; unknown ones still show', () => {
	expect(toolDetails.headline('inspect', { scope: 'self', fields: 'id,model,context' }).text).toBe('? inspect self (id, model, context)')
	expect(toolDetails.headline('inspect', { what: 'host' }).text).toBe('? inspect host')
	expect(toolDetails.lines('inspect', { scope: 'all', fields: 'tab', extra: 1 })).toEqual(['extra: 1'])
})
