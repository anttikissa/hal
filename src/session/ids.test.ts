import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sessionIds } from './ids.ts'

const origStateDir = process.env.HAL_STATE_DIR
const origNow = Date.now
let tempStateDir: string | null = null

function useTempStateDir(): string {
	tempStateDir = mkdtempSync(join(tmpdir(), 'hal-session-ids-'))
	process.env.HAL_STATE_DIR = tempStateDir
	return tempStateDir
}

afterEach(() => {
	Date.now = origNow
	if (origStateDir === undefined) delete process.env.HAL_STATE_DIR
	else process.env.HAL_STATE_DIR = origStateDir
	if (tempStateDir) rmSync(tempStateDir, { recursive: true, force: true })
	tempStateDir = null
})

test('reserve uses days since the stored epoch in the session id prefix', () => {
	const stateDir = useTempStateDir()
	const epochPath = `${stateDir}/epoch.txt`
	Bun.write(epochPath, '2026-03-15T00:00:00.000Z\n')
	Date.now = () => Date.parse('2026-04-24T12:00:00.000Z')

	const id = sessionIds.reserve()

	expect(id).toMatch(/^40-[a-z0-9]{3}$/)
	expect(existsSync(`${stateDir}/sessions/${id}`)).toBe(true)
})

test('reserve creates epoch.txt once and reuses it for later ids', () => {
	const stateDir = useTempStateDir()
	Date.now = () => Date.parse('2026-03-16T08:00:00.000Z')

	const first = sessionIds.reserve()
	const epochText = readFileSync(`${stateDir}/epoch.txt`, 'utf-8')

	Date.now = () => Date.parse('2026-03-18T08:00:00.000Z')
	const second = sessionIds.reserve()

	expect(first).toMatch(/^00-[a-z0-9]{3}$/)
	expect(second).toMatch(/^02-[a-z0-9]{3}$/)
	expect(readFileSync(`${stateDir}/epoch.txt`, 'utf-8')).toBe(epochText)
})
