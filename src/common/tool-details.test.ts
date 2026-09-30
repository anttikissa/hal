import { expect, test } from 'bun:test'
import { toolDetails } from './tool-details.ts'

test('inspection keeps malformed and unfamiliar arguments, multiline text and omitted controls distinct', () => {
	let command = 'python3 - <<\'PY\'\nprint("hello")\nPY'
	let text = toolDetails.lines('bash', 'call-1', { command, description: 'First line\nSecond line', modifies: '/tmp/log', extra: { flags: [false, null, ''] } }).join('\n')
	expect(text).toContain(command.split('\n').map((l) => `    ${l}`).join('\n'))
	expect(text).toContain('    First line\n    Second line')
	expect(text).toContain('Modifies (modifies) — text:\n    /tmp/log')
	expect(text).toContain('flags:')
	expect(text).toContain('1. false')
	expect(text).toContain('2. (null)')
	expect(text).toContain('3. (empty string)')
	expect(text).toContain('default false')
	expect(text).not.toContain('Modifies: not supplied')
	let supplied = toolDetails.lines('bash', 'call-2', { background: false, timeout: 0, modifies: [] }).join('\n')
	expect(supplied).toContain('Timeout (timeout) — number:\n    0')
	expect(supplied).toContain('(empty list)')
	expect(supplied).not.toContain('default false')
	expect(supplied).toContain('Command: not supplied (required)')
})
