// Rate limits the providers told us about (429, quota), per model and
// account, until the time they gave. Kept in state/limits.ason so a
// restart neither forgets a limit hours away nor hammers the provider
// for it: account rotation skips a limited account (auth.ts), and a
// provider without accounts is not asked again before then (provider.ts).

import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { clock } from './clock.ts'

// "provider/model" or "provider/model account".
function key(modelId: string, account?: string): string {
	return account ? `${modelId} ${account}` : modelId
}

// The latest limit on the model for the account: its own (a model the
// plan lacks, or whose credits ran out) or the account's (a 429: the
// subscription's quota is shared by all its models).
function on(modelId: string, account: string): number {
	return Math.max(limits.until(key(modelId, account)), limits.until(key(modelId.split('/')[0]!, account)))
}

// The live file for the current home; reopened if the home changes.
function store(): Record<string, string> {
	let path = `${paths.stateDir()}/limits.ason`
	if (limits.state.store && limits.state.path === path) return limits.state.store
	limits.close()
	limits.state.store = liveFiles.liveFile(path, {}, { watch: false, mode: 0o600 })
	limits.state.path = path
	return limits.state.store
}

// Until when (epoch ms) `key` is limited; 0 if it is not.
function until(key: string): number {
	let at = Date.parse(limits.store()[key] ?? '')
	return at > clock.now() ? at : 0
}

// Records a limit; forgets ones already over.
function set(key: string, at: number): void {
	let data = limits.store()
	for (let [k, v] of Object.entries(data)) if (!(Date.parse(v) > clock.now())) delete data[k]
	if (at > clock.now()) data[key] = new Date(at).toISOString()
}

// Whether a key limits `kind`: a model ("openai/m a@x") or a whole
// subscription account ("openai a@x").
function ofKind(key: string, kind: string): boolean {
	return key.startsWith(`${kind}/`) || key.startsWith(`${kind} `)
}

// Drops every limit on one account of a provider: a fresh login is new
// evidence that outdates them (a plan refusal before an upgrade).
// Drops the account's skips; true if there were any.
function forget(kind: string, account: string): boolean {
	let data = limits.store()
	let keys = Object.keys(data).filter((k) => limits.ofKind(k, kind) && k.endsWith(` ${account}`))
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
	set,
	ofKind,
	forget,
	close,
	state: { store: null as Record<string, string> | null, path: '' },
}
