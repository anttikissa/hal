import { expect, test } from 'bun:test'
import { shellCommand } from './shell-command.ts'

test('stripCdCwd removes a redundant leading cwd change', () => {
	expect(shellCommand.stripCdCwd('cd /tmp/../tmp && pwd', '/tmp/')).toBe('pwd')
	expect(shellCommand.stripCdCwd('cd /var && pwd', '/tmp')).toBe('cd /var && pwd')
})
