import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { modelWatch } from './model-watch.ts'
import { modelsDev } from './models-dev.ts'
import { paths } from './paths.ts'
import { provider, type Provider } from './provider.ts'
import { warnings } from './warnings.ts'

// Built-in models.dev watch (task jst): changes since the last check
// reach the user; a first check and a new provider stay quiet.

const savedHome = paths.state.home
const origProviders = provider.state.providers
let home = ''
const fake = { request: () => ({ url: '', headers: {}, body: {} }), parse: async function* () {} } as Provider
const catalog = (ids: string[]) => ({ acme: Object.fromEntries(ids.map((id) => [id, { name: id }])) }) as any

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-model-watch-`)
	paths.state.home = home
	paths.init()
	provider.state.providers = { acme: fake }
	warnings.state.held = []
})

afterEach(() => {
	provider.state.providers = origProviders
	modelsDev.state.catalog = null
	warnings.state.held = []
	paths.state.home = savedHome
	rmSync(home, { recursive: true, force: true })
})

test('reports added and removed models after the first check', () => {
	modelsDev.state.catalog = catalog(['a', 'b'])
	modelsDev.state.path = modelsDev.file()
	modelWatch.check()
	expect(warnings.state.held).toEqual([])
	modelsDev.state.catalog = catalog(['b', 'c'])
	modelWatch.check()
	expect(warnings.state.held).toEqual([{ type: 'warning', text: 'models.dev: new acme/c; removed acme/a' }])
})

test('checks at the same random time every 12 hours', () => {
	let { offsetMs } = modelWatch.load()
	let at = modelWatch.next(0)
	expect(at).toBe(offsetMs || modelWatch.periodMs)
	expect(modelWatch.next(at)).toBe(at + modelWatch.periodMs)
})
