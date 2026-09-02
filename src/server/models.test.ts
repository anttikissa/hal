import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { models } from '../common/models.ts'
import { auth } from './auth.ts'
import { serverModels } from './models.ts'

const origFetch = globalThis.fetch
const origStateDir = process.env.HAL_STATE_DIR

beforeEach(() => {
	auth._setStoreForTest({})
	models.hydrate({})
	serverModels.state.metadata = {}
})

afterEach(() => {
	globalThis.fetch = origFetch
	if (origStateDir === undefined) delete process.env.HAL_STATE_DIR
	else process.env.HAL_STATE_DIR = origStateDir
	models.state.cache = null
	serverModels.state.metadata = null
	auth._setStoreForTest({})
})

test('init hydrates the common registry from the persisted model cache', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-models-'))
	process.env.HAL_STATE_DIR = dir
	models.state.cache = null
	serverModels.state.metadata = null
	await Bun.write(join(dir, 'models.ason'), "{ version: 1, models: { 'gpt-5.7-terra': { context: 1050000, sources: [] } } }")
	try {
		serverModels.init()
		expect(models.resolveModel('terra')).toBe('openai/gpt-5.7-terra')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('gpt-5.5 gets high reasoning effort and fallback context window', () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-models-'))
	process.env.HAL_STATE_DIR = dir
	models.state.cache = null
	try {
		expect(models.reasoningEffort('openai/gpt-5.5')).toBe('high')
		expect(serverModels.contextWindow('openai/gpt-5.5')).toBe(1_050_000)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})


test('gpt-5.5 subscription route uses Codex input cap', () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-models-'))
	process.env.HAL_STATE_DIR = dir
	models.state.cache = null
	auth._setStoreForTest({ openai: { accessToken: 'tok', refreshToken: 'rt' } })
	try {
		expect(serverModels.contextWindow('openai/gpt-5.5')).toBe(272_000)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
test('Fable and gpt-instant have picker entries, fallback context, and prices', () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-models-'))
	process.env.HAL_STATE_DIR = dir
	models.state.cache = null
	try {
		expect(models.displayModel('anthropic/claude-fable-5-1')).toBe('Fable 5.1')
		expect(models.displayModel('openai/gpt-5.5-instant')).toBe('GPT 5.5 Instant')
		expect(serverModels.contextWindow('anthropic/claude-fable-5-1')).toBe(1_000_000)
		expect(serverModels.contextWindow('openai/gpt-5.5-instant')).toBe(400_000)
		expect(models.computeCost('anthropic/claude-fable-5-1', { input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 })).toBe(0.06)
		expect(models.computeCost('openai/gpt-5.5-instant', { input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 })).toBe(0.035)
		expect(models.listModelChoices().find((item) => item.value === 'fable')).toMatchObject({ search: expect.stringContaining('anthropic/claude-fable-5-1') })
		expect(models.listModelChoices().find((item) => item.value === 'gpt-instant')).toMatchObject({ leafLabel: 'gpt-instant', search: expect.stringContaining('openai/gpt-5.5-instant') })
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
test('refreshModels reports relevant GPT and Claude additions and context changes', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-models-'))
	process.env.HAL_STATE_DIR = dir
	models.state.cache = {
		'gpt-5.4': 400_000,
		'gpt-5.5': 400_000,
		'claude-opus-4-6': 1_000_000,
	}
	Bun.write(join(dir, 'models.ason'), '')
	globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({
		openai: {
			models: {
				'gpt-5.5': { limit: { context: 1_050_000 } },
				'gpt-5.6': { limit: { context: 1_200_000 } },
			},
		},
		anthropic: {
			models: {
				'claude-opus-4-6': { limit: { context: 1_000_000 } },
				'claude-sonnet-4-7': { limit: { context: 1_000_000 } },
			},
		},
	})), { preconnect: () => {} }) as typeof fetch

	try {
		const result = await serverModels.refreshModels()
		expect(result.fetched).toBe(true)
		expect(result.changes).toContain('gpt-5.5 context 400k → 1050k')
		expect(result.changes).toContain('new GPT model gpt-5.6 (1200k)')
		expect(result.changes).toContain('new Claude model claude-sonnet-4-7 (1000k)')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})


test('refreshModels stores model metadata and source providers in the ASON cache', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-models-'))
	process.env.HAL_STATE_DIR = dir
	globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({
		azure: {
			models: {
				'claude-mythos-5': {
					name: 'Claude Mythos 5',
					description: 'Restricted Claude model',
					family: 'claude-mythos',
					release_date: '2026-06-09',
					last_updated: '2026-06-09',
					status: 'beta',
					limit: { context: 1_000_000, output: 128_000 },
				},
			},
		},
	})), { preconnect: () => {} }) as typeof fetch

	try {
		await serverModels.refreshModels()
		const saved = readFileSync(join(dir, 'models.ason'), 'utf-8')
		expect(saved).toContain('version: 1')
		expect(saved).toContain("'claude-mythos-5': {")
		expect(saved).toContain("releaseDate: '2026-06-09'")
		expect(saved).toContain("provider: 'azure'")
		expect(saved).toContain("status: 'beta'")
		models.state.cache = null
		serverModels.state.metadata = null
		expect(serverModels.cachedModelMetadata('anthropic/claude-mythos-5')).toMatchObject({
			context: 1_000_000,
			family: 'claude-mythos',
			sources: [{ provider: 'azure', status: 'beta' }],
		})
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})


test('configured direct model source requires both a supported route and its credential', () => {
	serverModels.state.metadata = {
		'claude-mythos-5': { context: 1_000_000, sources: [{ provider: 'azure', context: 1_000_000 }] },
		'claude-fable-5': { context: 1_000_000, sources: [{ provider: 'anthropic', context: 1_000_000 }] },
	}
	expect(serverModels.hasConfiguredDirectSource('claude-mythos-5')).toBe(false)
	expect(serverModels.hasConfiguredDirectSource('claude-fable-5')).toBe(false)
	auth._setStoreForTest({ anthropic: { apiKey: 'test' } })
	expect(serverModels.hasConfiguredDirectSource('claude-fable-5')).toBe(true)
})

test('refreshModels treats missing cache as initial fetch without change spam', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-models-'))
	process.env.HAL_STATE_DIR = dir
	globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({
		openai: {
			models: {
				'gpt-5.5': { limit: { context: 1_050_000 } },
				'gpt-5.6': { limit: { context: 1_200_000 } },
			},
		},
		anthropic: {
			models: {
				'claude-sonnet-4-7': { limit: { context: 1_000_000 } },
			},
		},
	})), { preconnect: () => {} }) as typeof fetch

	try {
		const result = await serverModels.refreshModels()
		expect(result.fetched).toBe(true)
		expect(result.hadCache).toBe(false)
		expect(result.modelCount).toBe(3)
		expect(result.changes).toEqual([])
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
