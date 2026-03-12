import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readFiles } from './read-file.ts'

describe('readFiles', () => {
	let dir = ''
	let filePath = ''

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'hal-read-file-'))
		filePath = join(dir, 'sample.txt')
		writeFileSync(filePath, 'hello world')
		readFiles.config.enabled = true
		readFiles.clearSamples()
	})

	afterEach(() => {
		readFiles.clearSamples()
		rmSync(dir, { recursive: true, force: true })
	})

	test('records async text reads', async () => {
		const content = await readFiles.readText(filePath, 'test.async')
		expect(content).toBe('hello world')
		const profile = readFiles.getSamples()
		expect(profile.dropped).toBe(0)
		expect(profile.samples).toHaveLength(1)
		expect(profile.samples[0]).toMatchObject({
			path: filePath,
			source: 'test.async',
			mode: 'text',
			sync: false,
		})
		expect(profile.samples[0].elapsedMs).toBeGreaterThanOrEqual(0)
		expect(profile.samples[0].endedAtMs).toBeGreaterThanOrEqual(profile.samples[0].startedAtMs)
	})

	test('records sync text and byte reads', () => {
		const text = readFiles.readTextSync(filePath, 'test.sync.text')
		expect(text).toBe('hello world')
		const bytes = readFiles.readBytesSync(filePath, 'test.sync.bytes')
		expect(bytes.toString()).toBe('hello world')
		const profile = readFiles.getSamples()
		expect(profile.samples).toHaveLength(2)
		expect(profile.samples[0]).toMatchObject({
			path: filePath,
			source: 'test.sync.text',
			mode: 'text',
			sync: true,
			method: 'fs-readFileSync',
		})
		expect(profile.samples[1]).toMatchObject({
			path: filePath,
			source: 'test.sync.bytes',
			mode: 'bytes',
			sync: true,
			method: 'fs-readFileSync',
		})
	})
})
