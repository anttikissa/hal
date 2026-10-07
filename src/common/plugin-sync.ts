// Plugin sync messages (task zh7): a terminal client on another home
// compares its portable plugins with the host's. Inventories travel
// first (heads only); history and contents only when asked for. Every
// field crosses a trust boundary, so the host checks commands here and
// the client checks replies before using them; plugin-history.receive
// also verifies every version id and content hash.
// Tasks: zh7.

// One recorded plugin version, as task gev keeps it.
export type SyncVersion = { id: string; file: string; hash?: string; parent?: string; ts: string; deleted?: true; offline?: true }
// A file's current version on one home; no id: it has no history there.
export type SyncHead = { file: string; id?: string; hash?: string; ts?: string; deleted?: true; offline?: true }

// inventory: the host's portable heads plus heads for `names` (the
// client's portable files); the host's .syncignore names are left out
// and listed in `ignored`. history: every version of `files`. content:
// bytes by hash. fetch: `file`'s versions the client lacks (`known`
// ids) with their contents, if its head is still `expect` (absent: no
// history). apply: make `target` (absent: no file) the host's `file`
// if its head is still `expect`.
export type PluginSyncCommand = { type: 'plugin-sync' } & (
	| { op: 'inventory'; home: string; names: string[] }
	| { op: 'history'; files: string[] }
	| { op: 'content'; hashes: string[] }
	| { op: 'fetch'; file: string; known: string[]; expect?: string }
	| { op: 'apply'; file: string; versions: SyncVersion[]; contents: Record<string, string>; target?: string; expect?: string }
)

// The answer to command `request`, or with `changed` (no request) a
// portable host plugin changed. `stale`: the head was not the expected
// one; `head` is the current one. Contents are base64.
export type PluginSyncEvent = {
	type: 'plugin-sync'
	request?: string
	changed?: true
	home?: string
	heads?: SyncHead[]
	ignored?: string[]
	versions?: SyncVersion[]
	contents?: Record<string, string>
	stale?: true
	head?: SyncHead
	applied?: true
}

const ID = /^[0-9a-f]{16}$/
const HASH = /^[0-9a-f]{64}$/
const OPS = ['inventory', 'history', 'content', 'fetch', 'apply']

// A top-level plugin filename: no path, so a file operation stays in
// the plugins directory.
function isName(name: unknown): name is string {
	return typeof name === 'string' && name.length <= 200 && name.endsWith('.ts') && !name.endsWith('.d.ts') && !/[/\\\0]/.test(name) && name !== '.ts'
}

function isVersion(v: any): v is SyncVersion {
	return !!v && typeof v === 'object' && ID.test(v.id) && isName(v.file) && typeof v.ts === 'string' && (v.parent === undefined || ID.test(v.parent)) && (v.deleted === true ? v.hash === undefined : HASH.test(v.hash))
}

function isHead(h: any): h is SyncHead {
	return !!h && typeof h === 'object' && isName(h.file) && (h.id === undefined || ID.test(h.id)) && (h.hash === undefined || HASH.test(h.hash))
}

const list = (v: unknown, ok: (x: unknown) => boolean, max = 10_000) => Array.isArray(v) && v.length <= max && v.every(ok)
const contentsOk = (c: unknown) => !!c && typeof c === 'object' && !Array.isArray(c) && Object.entries(c).every(([h, b]) => HASH.test(h) && typeof b === 'string')

// Why command `c` (type plugin-sync) is malformed, or undefined.
function invalidCommand(c: Record<string, unknown>): string | undefined {
	let bad = (what: string) => `plugin-sync ${c.op}: ${what}`
	if (!OPS.includes(c.op as string)) return `plugin-sync: unknown op ${JSON.stringify(c.op)}`
	if (c.op === 'inventory') return typeof c.home !== 'string' ? bad('home must be a string') : list(c.names, isName) ? undefined : bad('names must be plugin filenames')
	if (c.op === 'history') return list(c.files, isName) ? undefined : bad('files must be plugin filenames')
	if (c.op === 'content') return list(c.hashes, (h) => HASH.test(h as string)) ? undefined : bad('hashes must be sha256 hex')
	if (!isName(c.file)) return bad('file must be a top-level plugin filename')
	if (c.expect !== undefined && !ID.test(c.expect as string)) return bad('expect must be a version id')
	if (c.op === 'fetch') return list(c.known, (id) => ID.test(id as string)) ? undefined : bad('known must be version ids')
	if (c.target !== undefined && !ID.test(c.target as string)) return bad('target must be a version id')
	if (!list(c.versions, (v) => isVersion(v) && v.file === c.file)) return bad(`versions must be versions of ${c.file}`)
	return contentsOk(c.contents) ? undefined : bad('contents must map sha256 hashes to base64')
}

// Why reply `e` is malformed, or undefined.
function invalidEvent(e: Record<string, unknown>): string | undefined {
	if (e.heads !== undefined && !list(e.heads, isHead)) return 'plugin-sync: invalid heads'
	if (e.versions !== undefined && !list(e.versions, isVersion)) return 'plugin-sync: invalid versions'
	if (e.ignored !== undefined && !list(e.ignored, isName)) return 'plugin-sync: invalid ignored names'
	if (e.contents !== undefined && !contentsOk(e.contents)) return 'plugin-sync: invalid contents'
	if (e.head !== undefined && !isHead(e.head)) return 'plugin-sync: invalid head'
	return undefined
}

// The names in a .syncignore text: one per line; blank lines and
// lines starting with # are skipped.
function ignoreList(text: string): string[] {
	return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
}

export const pluginSyncWire = { isName, isVersion, isHead, invalidCommand, invalidEvent, ignoreList }
