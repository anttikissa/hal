// Model selection. Config values are functions read at call time, so
// local.ts can replace them (see tasks/README.md).
//
// The model picker's list (tasks/w4/forms.md, Model picker) comes from
// here: every registered provider that can list its models, asked at
// most once per ttlMs, plus Hal's synthetic models. A provider that
// fails or is slow is left out this time and asked again next time.

import { settings } from '../common/settings.ts'
import { diag } from './diag.ts'
import { provider } from './provider.ts'
import { synthetic } from './synthetic.ts'

// One provider's model ids ("provider/model") and when they were got.
type Listing = { at: number; ids: string[] }

async function fetchList(name: string): Promise<string[] | undefined> {
	let p = provider.state.providers[name]
	if (!p?.models) return undefined
	let cached = models.state.lists.get(name)
	if (cached && Date.now() - cached.at < models.ttlMs()) return cached.ids
	let controller = new AbortController()
	let timer = setTimeout(() => controller.abort(), models.timeoutMs())
	try {
		let ids = (await Promise.race([
			p.models(controller.signal),
			new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timed out')))),
		])).map((m) => `${name}/${m}`)
		models.state.lists.set(name, { at: Date.now(), ids })
		return ids
	} catch (e: any) {
		diag.log(`models of ${name}: ${e?.message ?? e}`)
		return undefined
	} finally {
		clearTimeout(timer)
	}
}

// Every model id to offer, `current` first, then the default, the
// synthetic ones and each provider's in registration order.
async function list(current: string): Promise<string[]> {
	let lists = await Promise.all(Object.keys(provider.state.providers).map((name) => models.fetchList(name)))
	let hal = Object.keys(synthetic.models).map((m) => `hal/${m}`)
	return [...new Set([current, models.defaultModel(), ...hal, ...lists.flatMap((l) => l ?? [])])]
}

// The ids known without asking anyone: synthetic ones and cached lists.
function known(): string[] {
	return [...Object.keys(synthetic.models).map((m) => `hal/${m}`), ...[...models.state.lists.values()].flatMap((l) => l.ids)]
}

// Whether a session may switch to `id`: a synthetic model, or any
// model of a registered provider (lists are not complete: a provider
// may serve models it does not list).
function valid(id: string): boolean {
	if (/\s/.test(id)) return false
	if (id.startsWith('hal/')) return !!synthetic.find(id)
	let slash = id.indexOf('/')
	return slash > 0 && slash < id.length - 1 && !!provider.state.providers[id.slice(0, slash)]
}

export const models = {
	state: { lists: new Map<string, Listing>() },
	// provider/model id used when a session has not chosen one:
	// config.ason's `model`.
	defaultModel(): string {
		return settings.model()
	},
	// How long a provider's list is kept, and how long it may take.
	ttlMs: () => 3_600_000,
	timeoutMs: () => 3000,
	fetchList,
	list,
	known,
	valid,
}
