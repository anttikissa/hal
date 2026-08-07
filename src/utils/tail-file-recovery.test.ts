import { test, expect } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { tails } from './tail-file.ts'

test('tail finds an append by polling', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-tail-recovery-'))
	const path = join(dir, 'events.asonl')
	writeFileSync(path, '')
	let reader: any = null
	try {
		reader = tails.tailFile(path).getReader()
		const read = reader.read()
		// The tail is waiting at EOF. No filesystem notification is involved.
		await Bun.sleep(25)
		appendFileSync(path, 'recovered')
		const result = await Promise.race([
			read,
			Bun.sleep(500).then(() => {
				throw new Error('tail did not recover the append by polling')
			}),
		])
		expect(new TextDecoder().decode(result.value)).toBe('recovered')
	} finally {
		await reader?.cancel()
		rmSync(dir, { recursive: true, force: true })
	}
})

test('cancel wakes a pending poll wait promptly', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-tail-cancel-'))
	const path = join(dir, 'events.asonl')
	writeFileSync(path, '')
	const reader = tails.tailFile(path).getReader()
	try {
		const read = reader.read()
		await Bun.sleep(10)
		const canceled = await Promise.race([
			reader.cancel().then(() => true),
			Bun.sleep(50).then(() => false),
		])
		expect(canceled).toBe(true)
		expect((await read).done).toBe(true)
	} finally {
		await reader.cancel()
		rmSync(dir, { recursive: true, force: true })
	}
})
