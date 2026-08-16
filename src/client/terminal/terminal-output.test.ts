import { expect, test } from 'bun:test'
import { terminalOutput } from './terminal-output.ts'
import { render } from './render.ts'

function withStdoutWrite(run: (writes: string[]) => void): void {
	const original = process.stdout.write
	const writes: string[] = []
	process.stdout.write = ((chunk: string | Uint8Array) => {
		writes.push(String(chunk))
		return true
	}) as typeof process.stdout.write
	try {
		run(writes)
	} finally {
		process.stdout.write = original
		terminalOutput.setExternalEditorOpen(false)
	}
}


test('terminal output is latched while an external editor is open', () => {
	withStdoutWrite((writes) => {
		terminalOutput.setExternalEditorOpen(true)
		expect(terminalOutput.write('hal ui')).toBe(false)
		expect(writes).toEqual([])
	})
})

test('terminal output can deliberately hand the terminal to and from an external editor', () => {
	withStdoutWrite((writes) => {
		terminalOutput.setExternalEditorOpen(true)
		expect(terminalOutput.write('restore tty', { bypassExternalEditorLatch: true })).toBe(true)
		expect(writes).toEqual(['restore tty'])
	})
})


test('renderer cannot bypass the external editor latch', () => {
	withStdoutWrite((writes) => {
		terminalOutput.setExternalEditorOpen(true)
		render.draw(true)
		expect(writes).toEqual([])
	})
})
