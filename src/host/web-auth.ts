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
// state/web-sessions.ason (hash → expiry), so a restart keeps browsers
// logged in and the file alone logs nobody in.

import { clock } from './clock.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

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
function store(): Record<string, string> {
	let path = `${paths.stateDir()}/web-sessions.ason`
	let st = webAuth.state
	if (st.store && st.path === path) return st.store
	webAuth.close()
	st.store = liveFiles.liveFile(path, {}, { watch: false, mode: 0o600 })
	st.path = path
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
	codes.set(code, now + webAuth.codeMs())
	return code
}

// Swaps a typed code (untrusted: anything) for a new session token.
// 'limited': too many wrong codes this minute; nothing was checked.
function redeem(typed: unknown): { token: string } | { refused: 'wrong' | 'limited' } {
	let now = clock.now()
	let st = webAuth.state
	st.wrong = st.wrong.filter((t) => t > now - minute)
	if (st.wrong.length >= webAuth.maxWrong()) return { refused: 'limited' }
	let code = typeof typed === 'string' && typed.length <= 64 ? normalize(typed) : ''
	let until = st.codes.get(code)
	if (until === undefined || until <= now) {
		st.wrong.push(now)
		return { refused: 'wrong' }
	}
	st.codes.delete(code)
	let token = random(20)
	let data = webAuth.store()
	for (let [h, at] of Object.entries(data)) if (!(Date.parse(at) > now)) delete data[h]
	data[hash(token)] = new Date(now + webAuth.tokenMs()).toISOString()
	liveFiles.save(data)
	return { token }
}

// Whether a cookie value (untrusted) is a live session token.
function valid(token: unknown): boolean {
	if (typeof token !== 'string' || !/^[0-9a-hjkmnp-tv-z]{20}$/.test(token)) return false
	return Date.parse(webAuth.store()[hash(token)] ?? '') > clock.now()
}

// Ends every web session and forgets every code not yet used.
function revoke(): void {
	let data = webAuth.store()
	for (let h of Object.keys(data)) delete data[h]
	liveFiles.save(data)
	webAuth.state.codes.clear()
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
		store: null as Record<string, string> | null,
		path: '',
	},
	codeMs: (): number => 10 * minute,
	tokenMs: (): number => 10 * 365 * 24 * 60 * minute,
	maxWrong: (): number => 10,
	random,
	normalize,
	store,
	issue,
	redeem,
	valid,
	revoke,
	close,
}
