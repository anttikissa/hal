import { test, expect } from 'bun:test'
import { resolve } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const SHIFT_ENTER_GHOSTTY = '\x1b[57441;2u\x1b[13;2u\x1b[13;2:3u\x1b[57441;1:3u'

function lastCursorCol(out: string): number | null {
	const re = /\x1b\[(\d+)G\x1b\[\?25h/g
	let m: RegExpExecArray | null
	let last: number | null = null
	while ((m = re.exec(out)) !== null) last = Number(m[1])
	return Number.isFinite(last) ? last : null
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string, debug?: () => string): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await Bun.sleep(25)
	}
	const suffix = debug ? `\n--- debug ---\n${debug()}\n--- end debug ---` : ''
	throw new Error(`Timed out waiting for ${label}${suffix}`)
}

test('streaming assistant keeps terminal cursor in user prompt', async () => {
	const halDir = resolve(import.meta.dir, '../..')
	const stateDir = mkdtempSync(resolve(tmpdir(), 'hal-e2e-stream-cursor-'))
	const configPath = resolve(stateDir, 'config.ason')
	writeFileSync(configPath, '{ defaultModel: "mock/mock-1" }\n')

	const decoder = new TextDecoder()
	let out = ''
	const term = new Bun.Terminal({
		cols: 120,
		rows: 40,
		name: 'xterm-256color',
		data: (_term, data) => { out += decoder.decode(data, { stream: true }) },
	})

	const proc = Bun.spawn(['bun', 'src/main.ts'], {
		cwd: halDir,
		terminal: term,
		env: {
			...process.env,
			HAL_DIR: halDir,
			HAL_STATE_DIR: stateDir,
			HAL_CONFIG: configPath,
			TERM_PROGRAM: 'ghostty',
			TERM: 'xterm-256color',
		},
	})

	try {
		await waitFor(() => out.includes('help'), 8000, 'startup render', () => out.slice(-8000))

		const songStart = out.length
		term.write('song\r')
		await waitFor(() => out.slice(songStart).includes('quit busy'), 8000, 'busy state after song', () => out.slice(-8000))

		const helloStart = out.length
		term.write('hello')
		await waitFor(() => lastCursorCol(out.slice(helloStart)) === 7, 5000, 'cursor after hello', () => out.slice(-8000))

		const newlineStart = out.length
		term.write(SHIFT_ENTER_GHOSTTY)
		await waitFor(() => lastCursorCol(out.slice(newlineStart)) === 2, 5000, 'cursor after newline', () => out.slice(-8000))
	} finally {
		try { term.write('\u0003') } catch {}
		await Promise.race([proc.exited, Bun.sleep(1000)])
		if (proc.exitCode === null) proc.kill('SIGTERM')
		await proc.exited
		term.close()
		rmSync(stateDir, { recursive: true, force: true })
	}
}, 25000)
