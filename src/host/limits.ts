// Provider rate limits and model access refusals, per model and account.
// Kept in state/limits.ason so account rotation remembers both across
// restarts; access refusals never appear as quota deadlines.

import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { clock } from './clock.ts'

type Limit = string | { until: string; refusal: string }

// "provider/model" or "provider/model account".
function key(modelId: string, account?: string): string {
	return account ? `${modelId} ${account}` : modelId
}

// The latest quota deadline on the model or its shared account.
function on(modelId: string, account: string): number {
	return Math.max(limits.until(key(modelId, account)), limits.until(key(modelId.split('/')[0]!, account)))
}

// The live file for the current home; reopened if the home changes.
function store(): Record<string, Limit> {
	let path = `${paths.stateDir()}/limits.ason`
	if (limits.state.store && limits.state.path === path) return limits.state.store
	limits.close()
	limits.state.store = liveFiles.liveFile(path, {}, { watch: false, mode: 0o600 })
	limits.state.path = path
	return limits.state.store
}

// Until when (epoch ms) `key` is limited; 0 if it is not.
function until(key: string): number {
	let entry = limits.store()[key]
	let at = Date.parse(typeof entry === 'string' ? entry : '')
	return at > clock.now() ? at : 0
}

// The complete access error while its account/model cooldown is active.
function refusal(key: string): string | undefined {
	let entry = limits.store()[key]
	return entry && typeof entry !== 'string' && Date.parse(entry.until) > clock.now() ? entry.refusal : undefined
}

// Records a limit; forgets ones already over.
function set(key: string, at: number, refusal?: string): void {
	let data = limits.store()
	for (let [k, v] of Object.entries(data))
		if (!(Date.parse(typeof v === 'string' ? v : v.until) > clock.now())) delete data[k]
	if (at > clock.now()) {
		let until = new Date(at).toISOString()
		data[key] = refusal === undefined ? until : { until, refusal }
	}
}

// Whether a key limits `kind`: a model ("openai/m a@x") or a whole
// subscription account ("openai a@x").
function ofKind(key: string, kind: string): boolean {
	return key.startsWith(`${kind}/`) || key.startsWith(`${kind} `)
}

// Drops every limit on one account of a provider: a fresh login is new
// evidence that outdates them (a plan refusal before an upgrade).
// Drops the account's skips; true if there were any.
function forget(kind: string, account: string, refusals = true): boolean {
	let data = limits.store()
	let keys = Object.keys(data).filter(
		(k) => limits.ofKind(k, kind) && k.endsWith(` ${account}`) && (refusals || typeof data[k] === 'string'),
	)
	for (let k of keys) delete data[k]
	return keys.length > 0
}

function close(): void {
	let s = limits.state.store
	limits.state.store = null
	limits.state.path = ''
	if (s) liveFiles.close(s)
}

export const limits = {
	key,
	store,
	until,
	on,
	refusal,
	set,
	ofKind,
	forget,
	close,
	state: { store: null as Record<string, Limit> | null, path: '' },
}
