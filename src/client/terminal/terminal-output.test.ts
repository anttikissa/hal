import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../../utils/ason.ts'
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


test('captures exact terminal writes only when the local flight recorder is enabled', async () => {
	const dir = mkdtempSync(`${tmpdir()}/hal-terminal-output-`)
	const originalCapture = terminalOutput.config.capture
	const originalPath = terminalOutput.state.capturePath
	terminalOutput.state.capturePath = `${dir}/terminal-output.asonl`
	try {
		terminalOutput.config.capture = false
		withStdoutWrite(() => terminalOutput.write('not captured'))
		await terminalOutput.flush()
		expect(existsSync(terminalOutput.state.capturePath)).toBe(false)

		terminalOutput.config.capture = true
		withStdoutWrite(() => terminalOutput.write('\x1b[3J\r\nhello'))
		await terminalOutput.flush()
		const records = readFileSync(terminalOutput.state.capturePath, 'utf8').trim().split('\n').map((line) => ason.parse(line) as Record<string, any>)
		expect(records).toHaveLength(1)
		expect(records[0]).toMatchObject({ bytes: 11, rows: process.stdout.rows ?? 0, cols: process.stdout.columns ?? 0 })
		expect(Buffer.from(records[0]!.base64, 'base64').toString()).toBe('\x1b[3J\r\nhello')
	} finally {
		await terminalOutput.stopCapture()
		terminalOutput.config.capture = originalCapture
		terminalOutput.state.capturePath = originalPath
		rmSync(dir, { recursive: true, force: true })
	}
})
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
