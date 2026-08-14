import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { memory } from './memory.ts'

const origConfig = { ...memory.config }
const origReadRss = memory.io.readRss
const origAddEntry = memory.io.addEntry
const origScheduleExit = memory.io.scheduleExit
const origWriteDiagnostic = memory.io.writeDiagnostic

let entries: Array<{ text: string; type: string | undefined }>
let exitDelays: number[]
let diagnostics: Array<{ reason: string; rss: number }>

beforeEach(() => {
	entries = []
	exitDelays = []
	diagnostics = []
	Object.assign(memory.config, origConfig)
	memory.io.readRss = () => 0
	memory.io.addEntry = (text, type) => {
		entries.push({ text, type })
	}
	memory.io.scheduleExit = (delayMs) => {
		exitDelays.push(delayMs)
	}
	memory.io.writeDiagnostic = (reason, rss) => {
		diagnostics.push({ reason, rss })
	}
	memory.reset()
})

afterEach(() => {
	Object.assign(memory.config, origConfig)
	memory.io.readRss = origReadRss
	memory.io.addEntry = origAddEntry
	memory.io.scheduleExit = origScheduleExit
	memory.io.writeDiagnostic = origWriteDiagnostic
	memory.reset()
})

describe('memory', () => {
	test('warning threshold comes from config', () => {
		memory.config.warnBytes = 1_500_000_000
		memory.config.killBytes = 0
		memory.tick(1_499_999_999)
		expect(entries).toHaveLength(0)
		memory.tick(1_500_000_000)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({
			text: 'Memory high: 1.50 GB RSS',
			type: 'warning',
		})
		memory.tick(1_600_000_000)
		expect(entries).toHaveLength(1)
		expect(diagnostics).toEqual([{ reason: 'warning', rss: 1_500_000_000 }])
	})

	test('kill threshold comes from config', () => {
		memory.config.warnBytes = 0
		memory.config.killBytes = 1_800_000_000
		memory.config.exitDelayMs = 250
		memory.tick(1_799_999_999)
		expect(entries).toHaveLength(0)
		expect(exitDelays).toEqual([])
		memory.tick(1_800_000_000)
		expect(entries).toHaveLength(1)
		expect(entries[0]?.text).toContain('Memory limit exceeded: 1.80 GB RSS. Quitting.')
		expect(exitDelays).toEqual([250])
		expect(diagnostics).toEqual([{ reason: 'limit-exceeded', rss: 1_800_000_000 }])
	})

	test('records uncaught out-of-memory-like errors for later debugging', () => {
		const ordinary = memory.recordPossibleOom(new Error('ordinary crash'))
		const oom = memory.recordPossibleOom(new Error('JavaScript heap out of memory'))

		expect(ordinary).toBe(false)
		expect(oom).toBe(true)
		expect(diagnostics).toEqual([{ reason: 'uncaught-exception', rss: 0 }])
	})

	test('zero disables both warning and exit', () => {
		memory.config.warnBytes = 0
		memory.config.killBytes = 0
		memory.tick(9_999_000_000)
		expect(entries).toEqual([])
		expect(exitDelays).toEqual([])
	})
})
