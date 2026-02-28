import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { writeFileSync, unlinkSync } from 'fs'
import { contextWindowForModel, shouldWarn, resetModelCache } from './context.ts'
import { stringify } from './utils/ason.ts'
import { MODELS_FILE } from './state.ts'

const TEST_MODELS_FILE = MODELS_FILE + '.test'

// Patch MODELS_FILE for tests by writing to the real path, then cleaning up
function writeModels(data: Record<string, number>) {
	writeFileSync(MODELS_FILE, stringify(data) + '\n')
	resetModelCache()
}

let savedContent: string | null = null
try {
	savedContent = require('fs').readFileSync(MODELS_FILE, 'utf-8')
} catch {}

afterAll(() => {
	if (savedContent !== null) {
		writeFileSync(MODELS_FILE, savedContent)
	} else {
		try { unlinkSync(MODELS_FILE) } catch {}
	}
	resetModelCache()
})

describe('contextWindowForModel', () => {
	beforeEach(() => resetModelCache())

	test('returns default 200k when no models file', () => {
		try { unlinkSync(MODELS_FILE) } catch {}
		resetModelCache()
		expect(contextWindowForModel('gpt-5.3-codex')).toBe(200_000)
		expect(contextWindowForModel('claude-opus-4-6')).toBe(200_000)
	})

	test('reads context windows from models file', () => {
		writeModels({
			'gpt-5.3-codex': 400_000,
			'claude-opus-4-6': 200_000,
			'gpt-4.1': 1_047_576,
		})
		expect(contextWindowForModel('gpt-5.3-codex')).toBe(400_000)
		expect(contextWindowForModel('claude-opus-4-6')).toBe(200_000)
		expect(contextWindowForModel('gpt-4.1')).toBe(1_047_576)
	})

	test('returns default for unknown models', () => {
		writeModels({ 'gpt-5.3-codex': 400_000 })
		expect(contextWindowForModel('some-unknown-model')).toBe(200_000)
	})
})

describe('shouldWarn', () => {
	test('warns when context > 66%', () => {
		expect(shouldWarn({ input_tokens: 140_000 }, 200_000)).toBe(true)
		expect(shouldWarn({ input_tokens: 100_000 }, 200_000)).toBe(false)
	})

	test('uses correct context window for calculation', () => {
		expect(shouldWarn({ input_tokens: 270_000 }, 400_000)).toBe(true)
		expect(shouldWarn({ input_tokens: 130_000 }, 200_000)).toBe(false)
	})
})
