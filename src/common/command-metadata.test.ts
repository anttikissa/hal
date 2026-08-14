import { expect, test } from 'bun:test'
import { commandMetadata } from './command-metadata.ts'

test('shared command metadata exposes completion and help information', () => {
	expect(commandMetadata.commandNames()).toContain('resume')
	expect(commandMetadata.commandArg('resume')).toBe('closed-session')
	expect(commandMetadata.helpText('/config')).toContain('/config <module-or-path> <value>')
})
