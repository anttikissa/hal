// Web login (task 8a): a browser logs in with a one-time code and gets
// a session token for a cookie.
//
// A code is 6 lowercase Crockford base32 characters (30 bits), good for
// codeMs() and one login, and lives in this process's memory only. It
// is shown only in the reply to /auth and by `./run auth`, never saved,
// so a screenshot leaks nothing that lasts. Wrong codes are limited
// host-wide to maxWrong() a minute: past that every attempt is refused
// unchecked, so a 30-bit code can't be guessed in its lifetime.
//
// A right code is swapped for a token: 20 Crockford characters (100
// bits), good for tokenMs(). Only its SHA-256 is kept, in
// state/web-sessions.ason (hash → login metadata), so a restart keeps browsers
// logged in and the file alone logs nobody in.

import { clock } from './clock.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

export type WebLogin = { id: string; expires: string; firstSeen?: string; lastSeen?: string; device: string }
type Store = Record<string, string | WebLogin>

const alphabet = '0123456789abcdefghjkmnpqrstvwxyz'
const minute = 60_000

// `n` random Crockford characters; 256 is a multiple of 32, so & 31
// keeps them uniform.
function random(n: number): string {
	return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => alphabet[b & 31]).join('')
}

// A typed code as issued: case, spaces and dashes don't matter, and
// Crockford's look-alikes (i and l for 1, o for 0) are read as meant.
function normalize(typed: string): string {
	return typed.toLowerCase().replace(/[\s-]/g, '').replace(/[il]/g, '1').replace(/o/g, '0')
}

const hash = (token: string): string => new Bun.CryptoHasher('sha256').update(token).digest('hex')

// The token file of the current home; reopened if the home changes.
function store(): Store {
	let path = `${paths.stateDir()}/web-sessions.ason`
	let st = webAuth.state
	if (st.store && st.path === path) return st.store
	webAuth.close()
	st.store = liveFiles.liveFile<Store>(path, {}, { watch: false, mode: 0o600 })
	st.path = path
	let date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v))
	let ids = new Set<string>()
	for (let [h, e] of Object.entries(st.store)) {
		let good = /^[0-9a-f]{64}$/.test(h) && (typeof e === 'string' ? date(e) : e && typeof e === 'object' && !Array.isArray(e) && /^[0-9a-hjkmnp-tv-z]{10}$/.test(e.id) && !ids.has(e.id) && date(e.expires) && typeof e.device === 'string' && (e.firstSeen === undefined || date(e.firstSeen)) && (e.lastSeen === undefined || date(e.lastSeen)))
		if (!good) { webAuth.close(); throw new Error(`${path}: invalid web login ${h}: ${JSON.stringify(e)}`) }
		if (typeof e !== 'string') ids.add(e.id)
	}
	return st.store
}

// A fresh one-time code.
function issue(): string {
	let now = clock.now()
	let codes = webAuth.state.codes
	for (let [c, until] of codes) if (until <= now) codes.delete(c)
	let code: string
	do code = random(6)
	while (codes.has(code))
	codes.set(code, now + webAuth.codeMs)
	return code
}

// Swaps a typed code (untrusted: anything) for a new session token.
// 'limited': too many wrong codes this minute; nothing was checked.
function redeem(typed: unknown, device = 'browser'): { token: string } | { refused: 'wrong' | 'limited' } {
	let now = clock.now()
	let st = webAuth.state
	st.wrong = st.wrong.filter((t) => t > now - minute)
	if (st.wrong.length >= webAuth.maxWrong) return { refused: 'limited' }
	let code = typeof typed === 'string' && typed.length <= 64 ? normalize(typed) : ''
	let until = st.codes.get(code)
	if (until === undefined || until <= now) {
		st.wrong.push(now)
		return { refused: 'wrong' }
	}
	st.codes.delete(code)
	let token = random(20)
	let data = webAuth.store()
	for (let [h, at] of Object.entries(data)) if (!(Date.parse(typeof at === 'string' ? at : at.expires) > now)) delete data[h]
	let stamp = new Date(now).toISOString()
	data[hash(token)] = { id: random(10), expires: new Date(now + webAuth.tokenMs).toISOString(), firstSeen: stamp, lastSeen: stamp, device }
	liveFiles.save(data)
	return { token }
}

// Whether a cookie value (untrusted) is a live session token.
function tokenHash(token: unknown): string | undefined {
	return typeof token === 'string' && /^[0-9a-hjkmnp-tv-z]{20}$/.test(token) ? hash(token) : undefined
}

function validHash(h: string | undefined): boolean {
	let entry = h ? webAuth.store()[h] : undefined
	return !!entry && Date.parse(typeof entry === 'string' ? entry : entry.expires) > clock.now()
}

function valid(token: unknown): boolean {
	return webAuth.validHash(webAuth.tokenHash(token))
}

// Upgrade legacy expiry-only entries without rotating their tokens. Unknown
// device and first-seen dates remain explicitly unknown, never invented.
function list(): WebLogin[] {
	let data = webAuth.store()
	for (let [h, entry] of Object.entries(data)) if (typeof entry === 'string') data[h] = { id: random(10), expires: entry, device: 'browser (device not recorded)' }
	return Object.values(data).filter((e): e is WebLogin => typeof e !== 'string' && Date.parse(e.expires) > clock.now())
}

function touch(h: string | undefined): void {
	if (!h || !webAuth.validHash(h)) return
	webAuth.list()
	let entry = webAuth.store()[h] as WebLogin
	entry.lastSeen = new Date(clock.now()).toISOString()
}

// Deletes only the selected hashes; an id is public, never a bearer token.
function revoke(id = 'all'): string[] {
	webAuth.list()
	let data = webAuth.store()
	let hashes = Object.entries(data).filter(([, e]) => id === 'all' || (typeof e !== 'string' && e.id === id)).map(([h]) => h)
	for (let h of hashes) delete data[h]
	liveFiles.save(data)
	if (id === 'all') webAuth.state.codes.clear()
	return hashes
}

// Writes and closes the token file (the host stops); codes and the
// count of wrong ones go too.
function close(): void {
	let st = webAuth.state
	let s = st.store
	st.store = null
	st.path = ''
	st.codes.clear()
	st.wrong = []
	if (s) liveFiles.close(s)
}

export const webAuth = {
	state: {
		// Code → expiry (epoch ms).
		codes: new Map<string, number>(),
		// When each wrong code of the last minute came.
		wrong: [] as number[],
		store: null as Store | null,
		path: '',
	},
	codeMs: 10 * minute,
	tokenMs: 10 * 365 * 24 * 60 * minute,
	maxWrong: 10,
	random,
	normalize,
	store,
	issue,
	redeem,
	valid,
	tokenHash,
	validHash,
	list,
	touch,
	revoke,
	close,
}
