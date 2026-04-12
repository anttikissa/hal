import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { memory } from './memory.ts'

const origConfig = { ...memory.config }
const origReadRss = memory.io.readRss
const origAddEntry = memory.io.addEntry
const origScheduleExit = memory.io.scheduleExit

let entries: Array<{ text: string; type: string | undefined }>
let exitDelays: number[]

beforeEach(() => {
	entries = []
	exitDelays = []
	Object.assign(memory.config, origConfig)
	memory.io.readRss = () => 0
	memory.io.addEntry = (text, type) => {
		entries.push({ text, type })
	}
	memory.io.scheduleExit = (delayMs) => {
		exitDelays.push(delayMs)
	}
	memory.reset()
})

afterEach(() => {
	Object.assign(memory.config, origConfig)
	memory.io.readRss = origReadRss
	memory.io.addEntry = origAddEntry
	memory.io.scheduleExit = origScheduleExit
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
	})

	test('zero disables both warning and exit', () => {
		memory.config.warnBytes = 0
		memory.config.killBytes = 0
		memory.tick(9_999_000_000)
		expect(entries).toEqual([])
		expect(exitDelays).toEqual([])
	})
})
