// Several Google accounts for agy, recorded as non-secret references in
// secrets/auth.ason (`agy`: `{ email, keychain: true }` for agy's own
// Keychain login, or `{ email, geminiDir }` where agy stores its token
// file via SSH_CONNECTION + --gemini-dir). Hal stores no Google secrets.
// A session stays on its account until agy reports quota spent or account
// verification required (limits.ason), then rotates to the next (task xbp).
import { existsSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { auth } from './auth.ts'
import { limits } from './limits.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { secrets } from './secrets.ts'
import { agyPrompt } from './agy-prompt.ts'

type Entry = Record<string, any>

// `geminiDir` is undefined for agy's own Keychain login (`keychain: true`).
export type AgyAccount = {
	name: string
	email?: string
	geminiDir?: string
	keychain?: true
	entry: Entry
}

function resolveDir(dir: string): string {
	return isAbsolute(dir) ? dir : resolve(paths.home(), dir)
}

function all(): { data: Entry; list: AgyAccount[] } {
	let data: Entry = existsSync(paths.authFile()) ? auth.store() : {}
	let raw = data.agy
	if (raw === undefined) return { data, list: [] }
	let entries = Array.isArray(raw) ? raw : [raw]
	let list: AgyAccount[] = []
	for (let i = 0; i < entries.length; i++) {
		let entry = entries[i]
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
		let keychain = entry.keychain === true
		let dir = auth.usable(entry.geminiDir) ? entry.geminiDir : undefined
		if (!keychain && !dir) continue
		let email = auth.usable(entry.email) ? entry.email : undefined
		let name = email ?? (keychain ? 'keychain' : `account ${i + 1}`)
		list.push({
			name,
			...(email && { email }),
			...(dir && { geminiDir: resolveDir(dir) }),
			...(keychain && !dir && { keychain: true }),
			entry,
		})
	}
	if (!list.length) throw auth.fail('agy entry has no geminiDir or keychain')
	return { data, list }
}

function list(): AgyAccount[] {
	return agyAccounts.all().list
}

// The account of the agy session in agy.ason.
function saved(session: string): string | undefined {
	let data = agyPrompt.loadSaved(session)
	return data.account
}

function verifyOf(account: string): { message: string; url?: string } | undefined {
	return limits.verify(limits.key('agy', account))
}

function needsVerification(account: string, message: string, url?: string, session?: string): void {
	limits.setVerify(limits.key('agy', account), message, url)
	if (session && state.picked.get(session) === account) state.picked.delete(session)
}

function verified(account: string): void {
	limits.clearVerify(limits.key('agy', account))
}

function hasOther(excluding: string): boolean {
	return agyAccounts.list().some((a) => a.name !== excluding && !agyAccounts.verifyOf(a.name))
}

// Ordered accounts for `session`: picked, chosen, saved, then file order.
function ordered(all: AgyAccount[], session?: string): { order: AgyAccount[]; picked?: string } {
	let picked = session ? state.picked.get(session) : undefined
	let mine = picked ?? (session ? (state.chosen.get(session) ?? saved(session)) : undefined)
	let order = [...all.filter((a) => a.name === mine), ...all.filter((a) => a.name !== mine)]
	return { order, picked }
}

// The session's account for its next request, without mutating state
// (used by stats.plan). Undefined if no accounts or all are rate limited.
function next(model: string, session?: string): AgyAccount | undefined {
	let accounts = agyAccounts.list()
	if (!accounts.length) return undefined
	let { order, picked } = ordered(accounts, session)
	let anyLimited = false
	for (let a of order) {
		if (agyAccounts.verifyOf(a.name) && a.name !== picked) continue
		if (limits.on(`agy/${model}`, a.name)) {
			anyLimited = true
			continue
		}
		return a
	}
	return anyLimited ? undefined : order[0]
}

// The session's current account name for /status (* marker).
function selected(session: string): string | undefined {
	let accounts = agyAccounts.list()
	if (!accounts.length) return undefined
	let { order } = ordered(accounts, session)
	return order[0]?.name
}

// The session's account: /account pick, else last used (agy.ason survives
// restarts), else first in auth.ason; skipping accounts out of quota or
// needing verification (an explicit /account pick tries a verify-held
// account so verifying in browser can clear it). Throws `limited` when
// every non-verification account is out of quota.
function pick(model: string, session?: string): AgyAccount {
	let accounts = agyAccounts.list()
	if (!accounts.length) throw auth.fail('no agy login; run /login agy')
	let { order, picked } = ordered(accounts, session)
	let out: string[] = []
	let soonest = Infinity
	for (let a of order) {
		if (agyAccounts.verifyOf(a.name) && a.name !== picked) continue
		let until = limits.on(`agy/${model}`, a.name)
		if (!until) {
			if (session) {
				state.chosen.set(session, a.name)
				if (state.picked.get(session) !== a.name) state.picked.delete(session)
			}
			return a
		}
		soonest = Math.min(soonest, until)
		out.push(`${a.name} until ${new Date(until).toTimeString().slice(0, 5)}`)
	}
	if (soonest < Infinity) {
		throw Object.assign(new Error(`every agy account is out of quota for ${model}: ${out.join(', ')}`), {
			failure: 'limited',
			retryAt: soonest,
		})
	}
	// Every account needs verification: try the first so a verified user can recover.
	let a = order[0]!
	if (session) {
		state.chosen.set(session, a.name)
		if (state.picked.get(session) !== a.name) state.picked.delete(session)
	}
	return a
}

// Adds or updates `{ email, geminiDir }` in secrets/auth.ason (creating the
// file if needed) and clears prior limits and verification holds for it.
function save(email: string, geminiDir: string): void {
	let path = paths.authFile()
	let created = !existsSync(path)
	let data: Entry = created ? secrets.file(path, {}, { watch: false }) : auth.store()
	let old = data.agy
	let entries: Entry[] = old === undefined ? [] : Array.isArray(old) ? old : [old]
	let same = entries.findIndex((e) => e?.email === email)
	let nextEntry = { email, geminiDir }
	if (same >= 0) entries[same] = nextEntry
	else entries.push(nextEntry)
	data.agy = entries.length === 1 ? entries[0] : entries
	liveFiles.save(data)
	if (created) liveFiles.close(data)
	limits.forget('agy', email)
}

// Backfills `email` on an unnamed agy entry (e.g. `{ keychain: true }`) once
// agy reports the signed-in email in its ACP log.
function learnEmail(account: AgyAccount, email: string): boolean {
	if (account.email || !email.includes('@') || !existsSync(paths.authFile())) return false
	let { data, list: accounts } = agyAccounts.all()
	let found = accounts.find((a) =>
		account.geminiDir ? a.geminiDir === account.geminiDir : a.keychain && account.keychain,
	)
	if (!found || found.email) return false
	found.entry.email = email
	liveFiles.save(data)
	for (let map of [state.chosen, state.picked]) {
		for (let [k, v] of map) if (v === account.name) map.set(k, email)
	}
	account.email = email
	account.name = email
	return true
}

// agy's notice for a spent quota, sent as the turn's text: "⚠ Individual
// quota reached. ... Resets in 1h35m49s."
const quotaText = /^\s*⚠\s*(Individual quota reached\.[^\n]*?Resets in ((?:\d+h)?(?:\d+m)?(?:\d+s)?)\.)\s*$/

// The notice's message and seconds to reset; undefined for other text.
function quota(text: string): { message: string; resetsIn: number } | undefined {
	let m = quotaText.exec(text)
	if (!m) return undefined
	let part = (unit: string) => Number(new RegExp(`(\\d+)${unit}`).exec(m![2]!)?.[1] ?? 0)
	return { message: m[1]!, resetsIn: part('h') * 3600 + part('m') * 60 + part('s') }
}

const state = {
	// session -> the account /account picked, until rotation leaves it.
	picked: new Map<string, string>(),
	// session -> the account its last request ran on.
	chosen: new Map<string, string>(),
}

export const agyAccounts = {
	all,
	list,
	pick,
	next,
	selected,
	verifyOf,
	needsVerification,
	verified,
	hasOther,
	save,
	learnEmail,
	quota,
	state,
}
