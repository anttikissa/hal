import { test, expect } from 'bun:test'
import { resolve } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

test('shift+enter inserts newline in prompt (Ghostty key sequence)', async () => {
	const halDir = resolve(import.meta.dir, '../..')
	const stateDir = mkdtempSync(resolve(tmpdir(), 'hal-e2e-'))

	const proc = Bun.spawn(['bun', 'src/test-harness.ts'], {
		cwd: halDir,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'inherit',
		env: { ...process.env, HAL_DIR: halDir, HAL_STATE_DIR: stateDir },
	})

	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	const records: any[] = []

	async function readUntil(match: (r: any) => boolean, timeoutMs = 10000): Promise<any> {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const found = records.find(match)
			if (found) return found
			const remaining = deadline - Date.now()
			if (remaining <= 0) break
			const result = await Promise.race([
				reader.read(),
				Bun.sleep(remaining).then(() => null),
			])
			if (!result || result.done) break
			buffer += decoder.decode(result.value, { stream: true })
			const lines = buffer.split('\n')
			buffer = lines.pop()!
			for (const line of lines) {
				if (!line.trim()) continue
				try { records.push(JSON.parse(line)) } catch {}
			}
		}
		const found = records.find(match)
		if (found) return found
		throw new Error(`Timed out waiting. Records: ${JSON.stringify(records)}`)
	}

	try {
		await readUntil(r => r.type === 'ready')

		// Type "hello"
		proc.stdin.write('hello')
		await Bun.sleep(50)

		// Shift+Enter: Ghostty kitty protocol (shift-press, enter-press, enter-release, shift-release)
		proc.stdin.write('\x1b[57441;2u\x1b[13;2u\x1b[13;2:3u\x1b[57441;1:3u')
		await Bun.sleep(50)

		// Type "world"
		proc.stdin.write('world')
		await Bun.sleep(50)

		// Submit with Enter
		proc.stdin.write('\r')

		const promptEvent = await readUntil(r => r.type === 'prompt')
		expect(promptEvent.text).toBe('hello\nworld')
	} finally {
		try { proc.stdin.end() } catch {}
		await proc.exited
		try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
	}
}, 15000)
