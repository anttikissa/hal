import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { history } from './history.ts'
import { host } from './host.ts'
import { liveFiles } from './live-file.ts'
import { models } from './models.ts'
import { provider, type Provider } from './provider.ts'
import { modelsDev } from './models-dev.ts'
import { sessions } from './sessions.ts'
import { synthetic } from './synthetic.ts'
import { client, until } from './host-fixture.test.ts'

// /model and the model list: the host lists every configured
// provider's models, and switching is an ordinary command.

const savedHome = process.env.HAL_HOME
const origOnError = liveFiles.onError
const origModels = synthetic.models
const origProviders = provider.state.providers
let home = ''
let calls = 0

const fake = (ids: string[] | Error): Provider => ({
	request: () => ({ url: 'http://x', headers: {}, body: {} }),
	parse: async function* () {},
	models: async () => {
		calls++
		if (ids instanceof Error) throw ids
		return ids
	},
})

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-models-`)
	process.env.HAL_HOME = home
	mkdirSync(`${home}/state`)
	liveFiles.onError = () => {}
	calls = 0
	synthetic.models = { ...origModels, ok: () => ({ say: 'ok' }) }
	provider.state.providers = { acme: fake(['big-1', 'small-1']), down: fake(new Error('offline')) }
	modelsDev.state.catalog = null
	models.state.lists.clear()
	models.state.lists.set('acme', { at: Date.now(), ids: ['acme/big-1', 'acme/small-1'] })
})

afterEach(() => {
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	synthetic.models = origModels
	provider.state.providers = origProviders
	models.state.lists.clear()
	modelsDev.state.catalog = null
	liveFiles.onError = origOnError
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

function created(c: ReturnType<typeof client>, model = 'hal/intro'): string {
	c.conn.send({ type: 'create', cwd: home, model })
	return c.of('snapshot').at(-1).sessionId
}

async function opened(id: string) {
	let c = client()
	c.conn.send({ type: 'open', sessionId: id })
	await until(() => c.views.get(id))
	return c
}

test('the first picker opens from cached models, while provider requests warm the next one', async () => {
	models.state.lists.clear()
	let ids = models.list('acme/old-0')
	expect(ids[0]).toBe('acme/old-0')
	expect(ids).toEqual(expect.arrayContaining(['hal/intro', 'hal/ok']))
	expect(ids).not.toContain('acme/big-1')
	await until(() => models.state.lists.has('acme'))
	ids = models.list('acme/old-0')
	expect(ids).toEqual(expect.arrayContaining(['acme/big-1', 'acme/small-1']))
	expect(new Set(ids).size).toBe(ids.length)
	await until(() => calls >= 3)
})

test('family aliases choose a subscription before an API key, and explain missing access', () => {
	let before = [process.env.OPENCODE_API_KEY, process.env.OPENROUTER_API_KEY]
	try {
		provider.state.providers = { 'opencode-go': fake([]), openrouter: fake([]) }
		models.state.lists.set('opencode-go', { at: Date.now(), ids: ['opencode-go/kimi-k2'] })
		models.state.lists.set('openrouter', { at: Date.now(), ids: ['openrouter/moonshotai/kimi-k2'] })
		delete process.env.OPENCODE_API_KEY
		delete process.env.OPENROUTER_API_KEY
		expect(models.resolve('kimi').login).toContain('/login opencode')
		process.env.OPENROUTER_API_KEY = 'test-key'
		expect(models.resolve('kimi').id).toBe('openrouter/moonshotai/kimi-k2')
		process.env.OPENCODE_API_KEY = 'test-key'
		expect(models.resolve('kimi').id).toBe('opencode-go/kimi-k2')
	} finally {
		if (before[0] === undefined) delete process.env.OPENCODE_API_KEY
		else process.env.OPENCODE_API_KEY = before[0]
		if (before[1] === undefined) delete process.env.OPENROUTER_API_KEY
		else process.env.OPENROUTER_API_KEY = before[1]
	}
})

test('versioned GPT aliases complete and select their own generation', () => {
	let saved = process.env.OPENAI_API_KEY
	try {
		process.env.OPENAI_API_KEY = 'test-key'
		provider.state.providers = { openai: fake([]) }
		models.state.lists.set('openai', { at: Date.now(), ids: ['openai/gpt-6.1-sol', 'openai/gpt-6-astra', 'openai/gpt-6-sol'] })
		expect(models.resolve('gpt').id).toBe('openai/gpt-6.1-sol')
		expect(models.resolve('gpt6.1').id).toBe('openai/gpt-6.1-sol')
		expect(models.resolve('gpt6').id).toBe('openai/gpt-6-sol')
		expect(models.resolve('gpt-6.1').id).toBe('openai/gpt-6.1-sol')
		expect(models.resolve('astra').id).toBe('openai/gpt-6-astra')
		expect(models.resolve('luna').id).toBe('openai/gpt-6-luna')
		let c = client()
		let id = created(c)
		c.conn.send({ type: 'complete', sessionId: id, text: '/model gpt' })
		c.conn.send({ type: 'complete', sessionId: id, text: '/model ast' })
		expect(c.of('completions').at(-1)).toMatchObject({ items: ['/model astra'], descriptions: ['openai/gpt-6-astra'] })
		c.conn.send({ type: 'complete', sessionId: id, text: '/model gpt' })
		let reply = c.of('completions').at(-1)
		expect(reply.items).toEqual(['/model gpt', '/model gpt-6.1', '/model gpt-6', '/model openai/gpt-6-astra'])
		expect(reply.descriptions).toEqual(['openai/gpt-6.1-sol', 'openai/gpt-6.1-sol', 'openai/gpt-6-sol', 'openai/gpt-6-astra'])

	} finally {
		if (saved === undefined) delete process.env.OPENAI_API_KEY
		else process.env.OPENAI_API_KEY = saved
	}
})

test('popular GPT and Claude tier aliases select the intended model', () => {
	let openaiKey = process.env.OPENAI_API_KEY
	let anthropicKey = process.env.ANTHROPIC_API_KEY
	try {
		process.env.OPENAI_API_KEY = 'test-key'
		process.env.ANTHROPIC_API_KEY = 'test-key'
		provider.state.providers = { openai: fake([]), anthropic: fake([]) }
		for (let [alias, id] of Object.entries({ gpt: 'openai/gpt-6.1-sol', sol: 'openai/gpt-6.1-sol', astra: 'openai/gpt-6-astra', luna: 'openai/gpt-6-luna', sonnet: 'anthropic/claude-sonnet-5-5', fable: 'anthropic/claude-fable-5-1', haiku: 'anthropic/claude-haiku-4-5' })) {
			expect(models.resolve(alias).id).toBe(id)
		}
	} finally {
		if (openaiKey === undefined) delete process.env.OPENAI_API_KEY
		else process.env.OPENAI_API_KEY = openaiKey
		if (anthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
		else process.env.ANTHROPIC_API_KEY = anthropicKey
	}
})

test('a provider that never answers does not hold up the list', async () => {
	models.state.lists.clear()
	provider.state.providers.slow = { ...fake([]), models: (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }
	let saved = models.timeoutMs
	models.timeoutMs = 5
	try {
		models.list('acme/big-1')
		await until(() => models.state.lists.has('acme'))
		expect(models.list('acme/big-1')).toContain('acme/small-1')
	} finally {
		models.timeoutMs = saved
	}
})

test('/model <id> switches the session model for every follower and the next turn', async () => {
	let a = client()
	let id = created(a)
	let b = await opened(id)
	a.conn.send({ type: 'submit', sessionId: id, text: '/model hal/ok' })
	await until(() => b.views.get(id)!.meta.model === 'hal/ok')
	expect(sessions.open(id).model).toBe('hal/ok')
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => a.of('turn-end').length)
	expect(a.views.get(id)!.items.some((i) => i.type === 'text' && i.text === 'ok')).toBe(true)
})

test('/model refuses an id no provider serves', async () => {
	let a = client()
	let id = created(a)
	for (let text of ['/model nowhere/x', '/model plain', '/model hal/none']) a.conn.send({ type: 'submit', sessionId: id, text })
	await until(() => a.views.get(id)!.items.filter((i) => i.type === 'output' && i.error).length === 3)
	expect(sessions.open(id).model).toBe('hal/intro')
})

test('/model alone opens the picker on every client following the session', async () => {
	let a = client()
	let id = created(a)
	let b = await opened(id)
	let other = client()
	created(other)
	a.conn.send({ type: 'submit', sessionId: id, text: '/model', from: '9-xyz' })
	await until(() => b.of('models').length)
	await until(() => a.of('models').length)
	expect(b.of('models')[0]).toMatchObject({ sessionId: id, current: 'hal/intro', items: expect.arrayContaining(['acme/big-1']) })
	expect(other.of('models')).toEqual([])
})

test('the models command lists them for the asker only, recording nothing', async () => {
	let a = client()
	let id = created(a)
	let b = await opened(id)
	let before = history.readSync(id).length
	a.conn.send({ type: 'models', sessionId: id })
	await until(() => a.of('models').length)
	expect(a.of('models')[0].items).toContain('acme/small-1')
	expect(b.of('models')).toEqual([])
	expect(history.readSync(id).length).toBe(before)
})

test('/model completes model ids the host knows', async () => {
	let a = client()
	let id = created(a)
	await models.list('hal/intro')
	a.conn.send({ type: 'complete', sessionId: id, text: '/model acme/b' })
	expect(a.of('completions').at(-1).items).toEqual(['/model acme/big-1'])
	// A word inside the name matches too, after prefix matches.
	a.conn.send({ type: 'complete', sessionId: id, text: '/model bi' })
	expect(a.of('completions').at(-1).items).toContain('/model acme/big-1')
})

test('credential changes invalidate cached and in-flight model lists', async () => {
	let key = 'first'
	provider.state.providers.acme!.modelsKey = () => key
	await models.fetchList('acme')
	expect(models.known()).toContain('acme/big-1')
	key = 'second'
	expect(models.known()).not.toContain('acme/big-1')
	let resolve!: (ids: string[]) => void
	provider.state.providers.acme!.models = () => new Promise((done) => { resolve = done })
	let pending = models.fetchList('acme')
	key = 'third'
	resolve(['stale'])
	await pending
	expect(models.known()).not.toContain('acme/stale')
	provider.state.providers.acme!.models = async () => ['fresh']
	await models.fetchList('acme')
	expect(models.known()).toContain('acme/fresh')
})
