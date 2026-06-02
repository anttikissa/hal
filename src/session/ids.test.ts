import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sessionIds } from './ids.ts'
import { ason } from '../utils/ason.ts'

const origStateDir = process.env.HAL_STATE_DIR
const origNow = Date.now
let tempStateDir: string | null = null
const origWordsPath = sessionIds.config.wordsPath
const origRandom = Math.random

function useTempStateDir(): string {
	tempStateDir = mkdtempSync(join(tmpdir(), 'hal-session-ids-'))
	process.env.HAL_STATE_DIR = tempStateDir
	return tempStateDir
}

function readMeta(stateDir: string): any {
	return ason.parse(readFileSync(`${stateDir}/meta.ason`, 'utf-8'))
}

function writeWordsFile(words: string): string {
	const stateDir = useTempStateDir()
	const path = `${stateDir}/words3.txt`
	writeFileSync(path, words)
	sessionIds.config.wordsPath = path
	return path
}

afterEach(() => {
	Date.now = origNow
	if (origStateDir === undefined) delete process.env.HAL_STATE_DIR
	else process.env.HAL_STATE_DIR = origStateDir
	sessionIds.config.wordsPath = origWordsPath
	Math.random = origRandom
	if (tempStateDir) rmSync(tempStateDir, { recursive: true, force: true })
	tempStateDir = null
})

test('make picks a three-letter word from four-byte slots', () => {
	writeWordsFile('aaa bbb\n')
	Math.random = () => 0.6

	expect(sessionIds.make(new Date('2026-03-16T08:00:00.000Z'), Date.parse('2026-03-16T08:00:00.000Z'))).toBe('00-bbb')
})

test('make rejects bad word slots', () => {
	writeWordsFile('aa!\n')
	Math.random = () => 0

	expect(() => sessionIds.make(new Date('2026-03-16T08:00:00.000Z'), Date.parse('2026-03-16T08:00:00.000Z'))).toThrow('Invalid session word')
})

test('words3 file is sorted four-byte slots', () => {
	const wordsFile = readFileSync(origWordsPath, 'utf-8')
	const words: string[] = []
	for (let pos = 0; pos < wordsFile.length; pos += 4) {
		const word = wordsFile.slice(pos, pos + 3)
		const separator = wordsFile[pos + 3]
		expect(word).toMatch(/^[a-z0-9]{3}$/)
		expect(separator === ' ' || separator === '\n').toBe(true)
		words.push(word)
	}
	expect(words).toEqual([...words].sort())
})

test('reserve uses days since the stored meta epoch in the session id prefix', () => {
	const stateDir = useTempStateDir()
	Bun.write(`${stateDir}/meta.ason`, "{ epoch: '2026-03-15T00:00:00.000Z' }\n")
	Date.now = () => Date.parse('2026-04-24T12:00:00.000Z')

	const id = sessionIds.reserve()

	expect(id).toMatch(/^40-[a-z0-9]{3}$/)
	expect(existsSync(`${stateDir}/sessions/${id}`)).toBe(true)
})

test('reserve creates meta.ason epoch once and reuses it for later ids', () => {
	const stateDir = useTempStateDir()
	Date.now = () => Date.parse('2026-03-16T08:00:00.000Z')

	const first = sessionIds.reserve()
	const epoch = readMeta(stateDir).epoch

	Date.now = () => Date.parse('2026-03-18T08:00:00.000Z')
	const second = sessionIds.reserve()

	expect(first).toMatch(/^00-[a-z0-9]{3}$/)
	expect(second).toMatch(/^02-[a-z0-9]{3}$/)
	expect(readMeta(stateDir).epoch).toBe(epoch)
})

