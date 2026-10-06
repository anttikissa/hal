import { expect, test } from 'bun:test'
import { commandCheck } from './command-check.ts'

// A peer's version reaches git as a revision argument (/version).
test('a hello version must be a short hash, never a git option', () => {
	expect(commandCheck.invalid({ type: 'hello', pid: 1, version: 'abc1234+def5678', newCode: true })).toBeUndefined()
	expect(commandCheck.invalid({ type: 'hello', pid: 1, version: '--output=/tmp/x' })).toContain('short hash')
})
