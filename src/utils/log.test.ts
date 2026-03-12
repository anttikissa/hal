import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Log } from './log.ts'

const tempDirs: string[] = []

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Log.trim', () => {
	test('keeps newest entries', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'hal-log-trim-'))
		tempDirs.push(dir)
		const path = join(dir, 'events.asonl')
		const log = new Log<{ n: number }>(path)
		for (let i = 1; i <= 6; i++) await log.append({ n: i })
		await log.trim(3)
		expect(await log.readAll()).toEqual([{ n: 4 }, { n: 5 }, { n: 6 }])
	})

	test('empties file when keep is zero', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'hal-log-trim-'))
		tempDirs.push(dir)
		const path = join(dir, 'events.asonl')
		const log = new Log<{ n: number }>(path)
		await log.append({ n: 1 }, { n: 2 })
		await log.trim(0)
		expect(readFileSync(path, 'utf-8')).toBe('')
	})
})
