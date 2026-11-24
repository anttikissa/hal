// Several Google accounts for agy, so a session moves on when one runs
// out of quota. agy's own login (the macOS Keychain) is the first
// account, "default". Each other one is a gemini dir,
// state/agy/<name>/gemini: with SSH_CONNECTION set agy bypasses the
// Keychain and keeps the login in that dir's
// antigravity-cli/antigravity-oauth-token, written by
// `SSH_CONNECTION=x agy acp --gemini-dir <dir> --login`. A separate HOME
// would also isolate the Keychain, but agy's commands then see that HOME.
// A session stays on its account until agy reports the quota spent
// (limits.ason), then takes the next (task xbp).
import { existsSync, readdirSync } from 'fs'
import { limits } from './limits.ts'
import { paths } from './paths.ts'
import { agyPrompt } from './agy-prompt.ts'

// `geminiDir` is undefined for agy's own login.
export type AgyAccount = { name: string; geminiDir?: string }

function list(): AgyAccount[] {
	let root = `${paths.stateDir()}/agy`
	let names: string[] = []
	try {
		names = readdirSync(root).filter(
			(n) => n !== 'default' && existsSync(`${root}/${n}/gemini/antigravity-cli/antigravity-oauth-token`),
		)
	} catch {} // no accounts directory: only the default
	return [{ name: 'default' }, ...names.sort().map((name) => ({ name, geminiDir: `${root}/${name}/gemini` }))]
}

// The session's account: the one /account picked, else the one it ran
// on last (agy.ason survives a restart), else the default; passing over
// accounts out of quota for `model`. Throws `limited` when all are.
function pick(model: string, session?: string): AgyAccount {
	let all = agyAccounts.list()
	let mine = session ? (state.picked.get(session) ?? state.chosen.get(session) ?? saved(session)) : undefined
	let order = [...all.filter((a) => a.name === mine), ...all.filter((a) => a.name !== mine)]
	let out: string[] = []
	let soonest = Infinity
	for (let a of order) {
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
	throw Object.assign(new Error(`every agy account is out of quota for ${model}: ${out.join(', ')}`), {
		failure: 'limited',
		retryAt: soonest,
	})
}

// The account of the agy session in agy.ason; one saved before accounts
// existed ran on the default HOME.
function saved(session: string): string | undefined {
	let data = agyPrompt.loadSaved(session)
	return data.account ?? (data.acpSession ? 'default' : undefined)
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

export const agyAccounts = { list, pick, quota, state }
