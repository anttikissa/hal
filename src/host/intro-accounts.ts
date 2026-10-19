// What the intro (intro.ts) can offer: the accounts that can use a
// provider, and the models those accounts and local servers can run.
import { existsSync } from 'fs'
import { auth } from './auth.ts'
import { models } from './models.ts'
import { modelsDev } from './models-dev.ts'
import { paths } from './paths.ts'

type Entry = Record<string, any>

// Who can use a provider: a nonempty file account (accessToken or
// apiKey) or an environment key. Identities only, never the values;
// malformed credentials fail rather than disappear.
function accounts(): { names: string[]; providers: string[]; stored: number } {
	let data: Entry = existsSync(paths.authFile()) ? auth.store() : {}
	let names: string[] = [],
		providers: string[] = [],
		stored = 0
	for (let [kind, label, env] of [
		['anthropic', 'Claude', 'ANTHROPIC_API_KEY'],
		['openai', 'ChatGPT', 'OPENAI_API_KEY'],
		['opencode-go', 'OpenCode Go', 'OPENCODE_API_KEY'],
	] as const) {
		let entries = data[kind] === undefined ? [] : Array.isArray(data[kind]) ? data[kind] : [data[kind]]
		for (let entry of entries)
			if (
				(typeof entry?.accessToken === 'string' && entry.accessToken.length > 0) ||
				(typeof entry?.apiKey === 'string' && entry.apiKey.length > 0)
			) {
				names.push(`${label}${entry.email ? ` (${entry.email})` : ''}`)
				providers.push(kind)
				stored++
			}
		if (process.env[env]) {
			names.push(`${label} (${env})`)
			providers.push(kind)
		}
	}
	return { names, providers, stored }
}

// The claude and gpt aliases' current targets a credential can use,
// by display name: label → id.
// Then local Ollama models, if the greeting's warm-up found any.
function choices(providers: string[]): Map<string, string> {
	let out = new Map<string, string>()
	for (let [alias, family] of [
		['claude', 'Claude'],
		['gpt', 'GPT'],
	] as const) {
		let id = models.resolve(alias).id
		if (id && providers.includes(id.split('/')[0]!)) out.set(modelsDev.displayName(id) ?? family, id)
	}
	for (let id of models.cached('ollama')?.ids.slice(0, 4) ?? [])
		out.set(`${id.slice('ollama/'.length)} (Ollama, local)`, id)
	return out
}

export const introAccounts = { accounts, choices }
