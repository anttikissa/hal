// The files and editor belong to this client, including remote terminals (7ke).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Command, Event } from '../common/protocol.ts'
import { rebaseRows } from '../common/rebase-rows.ts'
import { keys } from './keys.ts'
import { terminal } from './terminal.ts'

async function edit(path: string): Promise<void> {
	let editor = process.env.VISUAL || process.env.EDITOR || 'vi'
	if (terminal.state.escapeTimer) clearTimeout(terminal.state.escapeTimer)
	terminal.state.escapeTimer = null
	terminal.state.decoder = keys.createState()
	terminal.state.external = true
	terminal.leave()
	process.stdin.pause()
	try {
		let child = Bun.spawn(['sh', '-c', `${editor} "$1"`, 'hal-rebase-editor', path], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
		let code = await child.exited
		if (code !== 0) throw new Error(`Editor ${editor} exited with code ${code}; file: ${path}`)
	} finally {
		terminal.state.external = false
		if (terminal.state.io) terminal.enter()
		process.stdin.resume()
		terminal.redraw('the rebase editor closing')
	}
}

async function open(event: Event & { type: 'rebase-plan' }, send: (command: Command) => void, report: (text: string) => void): Promise<void> {
	if (rebaseEditor.busy) {
		let text = 'A rebase editor is already open; finish or cancel it first.'
		send({ type: 'rebase-error', sessionId: event.sessionId, text })
		return report(text)
	}
	rebaseEditor.busy = true
	let dir: string | undefined
	try {
		dir = mkdtempSync(join(tmpdir(), 'hal-rebase-'))
		let path = join(dir, 'todo.txt')
		writeFileSync(path, event.todo, { mode: 0o600 })
		await rebaseEditor.edit(path)
		let todo = readFileSync(path, 'utf8'), parsed = rebaseRows.parse(todo, event.snapshot)
		let replacements: Record<number, string> = {}
		if (!parsed.aborted) for (let n of parsed.edits) {
			let row = event.snapshot.rows.find((row) => row.n === n)!
			let full = join(dir, `record-${n}.txt`)
			writeFileSync(full, row.text!, { mode: 0o600 })
			await rebaseEditor.edit(full)
			replacements[n] = readFileSync(full, 'utf8')
		}
		// The host parses again against its latest history before any write.
		let id = `rebase-${crypto.randomUUID()}`
		rebaseEditor.pending.set(id, dir)
		send({ type: 'rebase-apply', id, sessionId: event.sessionId, base: event.snapshot.base, todo, replacements, recoveryPath: dir })
	} catch (error) {
		let text = `${error instanceof Error ? error.message : String(error)}${dir ? `\nRebase files kept at ${dir}` : ''}`
		send({ type: 'rebase-error', sessionId: event.sessionId, text })
		report(text)
	} finally {
		rebaseEditor.busy = false
	}
}

function result(event: Event & { type: 'rebase-result' }, report: (text: string) => void): void {
	let dir = event.command && rebaseEditor.pending.get(event.command)
	if (!dir) return
	if (event.ok) rmSync(dir, { recursive: true })
	rebaseEditor.pending.delete(event.command!)
	report(event.text)
}

export const rebaseEditor = { edit, open, result, busy: false, pending: new Map<string, string>() }
