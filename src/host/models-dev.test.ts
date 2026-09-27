import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { picker } from '../common/picker.ts'
import { diag } from './diag.ts'
import { models } from './models.ts'
import { modelsDev } from './models-dev.ts'
import { paths } from './paths.ts'
import { provider, type Provider } from './provider.ts'

// models.dev (task qq): fetched in the background, cached under state/,
// used offline; never the network in tests.

const savedHome = process.env.HAL_HOME
const origFetch = provider.fetch
const origOffline = modelsDev.offline
const origProviders = provider.state.providers
let home = ''
let answer: () => Response | Promise<Response>
let fetched: string[] = []

const api = (models: Record<string, Record<string, { name?: string; limit?: { context: number } }>>) =>
	Object.fromEntries(Object.entries(models).map(([p, m]) => [p, { id: p, api: 'x', env: ['X'], models: m }]))

const catalog1 = api({
	anthropic: { 'claude-big-2': { name: 'Claude Big 2', limit: { context: 1_000_000 } }, 'claude-old-1': { name: 'Claude Old 1', limit: { context: 200_000 } } },
	openrouter: { 'acme/claude-big-2': { limit: { context: 900_000 } }, 'acme/solo-1': { limit: { context: 64_000 } } },
})

const fake = (models?: Provider['models'], known?: string[]): Provider => ({
	request: () => ({ url: 'http://x', headers: {}, body: {} }),
	parse: async function* () {},
	...(models ? { models } : {}),
	...(known ? { known: () => known } : {}),
})

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-models-dev-`)
	process.env.HAL_HOME = home
	paths.init()
	fetched = []
	modelsDev.offline = () => false
	answer = () => Response.json(catalog1)
	provider.fetch = async (url) => {
		fetched.push(url)
		return answer()
	}
	modelsDev.state.catalog = null
	models.state.lists.clear()
})

afterEach(() => {
	provider.fetch = origFetch
	modelsDev.offline = origOffline
	provider.state.providers = origProviders
	modelsDev.state.catalog = null
	models.state.lists.clear()
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

test('a refresh is cached and serves context windows and lists offline, after a restart', async () => {
	expect(modelsDev.contextWindow('anthropic/claude-big-2')).toBeUndefined()
	expect(await modelsDev.refresh()).toEqual([])
	expect(fetched).toEqual([modelsDev.url()])
	// A new host: nothing in memory, and the network is gone.
	modelsDev.state.catalog = null
	answer = () => Promise.reject(new Error('offline'))
	expect(modelsDev.contextWindow('anthropic/claude-big-2')).toBe(1_000_000)
	expect(models.contextWindow('openrouter/acme/claude-big-2')).toBe(900_000)
	// A provider models.dev does not list under that name: any provider's entry for the id.
	expect(modelsDev.contextWindow('work/claude-old-1')).toBe(200_000)
	expect(modelsDev.contextWindow('anthropic/unknown-9')).toBeUndefined()
	expect(modelsDev.ids('anthropic').sort()).toEqual(['claude-big-2', 'claude-old-1'])
	expect(models.names(['anthropic/claude-big-2', 'openrouter/acme/solo-1'])).toEqual({ 'anthropic/claude-big-2': 'Claude Big 2' })
})

test('a failed fetch keeps the old cache and is noted only in diagnostics', async () => {
	await modelsDev.refresh()
	let before = readFileSync(modelsDev.file(), 'utf-8')
	for (let fail of [() => new Response('down', { status: 503 }), () => Promise.reject(new Error('offline')), () => new Response('not json')]) {
		answer = fail
		expect(await modelsDev.refresh(['anthropic/claude-big-2'])).toEqual([])
	}
	expect(readFileSync(modelsDev.file(), 'utf-8')).toBe(before)
	expect(modelsDev.contextWindow('anthropic/claude-big-2')).toBe(1_000_000)
	expect(readFileSync(diag.file(), 'utf-8').match(/models\.dev/g)?.length).toBe(3)
})

test('a refresh reports picked models it listed before and no longer does', async () => {
	await modelsDev.refresh()
	answer = () => Response.json(api({ anthropic: { 'claude-big-2': { limit: { context: 1_000_000 } } } }))
	let gone = await modelsDev.refresh(['anthropic/claude-big-2', 'anthropic/claude-old-1', 'openrouter/acme/solo-1', 'anthropic/never-listed'])
	expect(gone).toEqual(['anthropic/claude-old-1', 'openrouter/acme/solo-1'])
	// The first fetch has nothing to compare with.
	rmSync(modelsDev.file())
	modelsDev.state.catalog = null
	expect(await modelsDev.refresh(['anthropic/claude-big-2', 'anthropic/claude-old-1'])).toEqual([])
})

test('a corrupt cache is an error naming its file', () => {
	writeFileSync(`${home}/state/models-dev.json`, '{"anthropic": ')
	expect(() => modelsDev.ids('anthropic')).toThrow(modelsDev.file())
})

test('the picker lists a provider’s own models first, else models.dev plus its built-in ones', async () => {
	provider.state.providers = {
		anthropic: fake(async () => ['claude-own-3'], ['claude-builtin-1']),
		openrouter: fake(),
		broken: fake(async () => {
			throw new Error('401')
		}, ['builtin-1']),
	}
	// No cache yet: own list, then built-in, then nothing.
	expect(await models.fetchList('anthropic')).toEqual(['anthropic/claude-own-3'])
	expect(await models.fetchList('broken')).toEqual(['broken/builtin-1'])
	expect(await models.fetchList('openrouter')).toBeUndefined()
	await modelsDev.refresh()
	models.state.lists.clear()
	expect(await models.fetchList('anthropic')).toEqual(['anthropic/claude-own-3'])
	expect((await models.fetchList('openrouter'))?.sort()).toEqual(['openrouter/acme/claude-big-2', 'openrouter/acme/solo-1'])
	provider.state.providers.anthropic = fake(async () => {
		throw new Error('invalid_grant')
	}, ['claude-builtin-1'])
	models.state.lists.clear()
	expect((await models.fetchList('anthropic'))?.sort()).toEqual(['anthropic/claude-big-2', 'anthropic/claude-builtin-1', 'anthropic/claude-old-1'])
	// Completion knows them without asking anyone.
	expect(models.known()).toEqual(expect.arrayContaining(['anthropic/claude-old-1', 'openrouter/acme/solo-1', 'broken/builtin-1']))
	expect(existsSync(modelsDev.file())).toBe(true)
})

test('the picker search matches display names too', () => {
	let ids = ['acme/x-17b', 'acme/x-9', 'anthropic/claude-big-2']
	let names = { 'acme/x-17b': 'Falcon Seventeen', 'anthropic/claude-big-2': 'Claude Big 2' }
	expect(picker.rank(ids, 'falcon', names)).toEqual(['acme/x-17b'])
	expect(picker.rank(ids, 'claude big', names)[0]).toBe('anthropic/claude-big-2')
	expect(picker.rank(ids, 'falcon')).toEqual([])
})
