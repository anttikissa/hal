// API keys stored by /login (such as /login opencode) in this home's
// credentials file, as `<provider>: { apiKey }` beside the anthropic
// logins (auth.ts). A stored key comes first; the provider's
// environment variable is the fallback (openai-compat.ts).
//
// Errors name the file, never the key.

import { existsSync } from 'fs'
import { auth } from './auth.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

// The key stored for `name`, if any. An entry without one is corrupt.
function get(name: string): string | undefined {
	if (!existsSync(paths.authFile())) return undefined
	let entry = auth.store()[name]
	if (entry === undefined) return undefined
	if (typeof entry?.apiKey !== 'string' || !entry.apiKey) {
		throw Object.assign(new Error(`${paths.display(paths.authFile())}: ${name} entry has no apiKey`), { failure: 'auth' })
	}
	return entry.apiKey
}

// Stores `key` for `name`, replacing any old one; creates the file
// (0600) if there is none. Sessions blocked on login look again.
function save(name: string, key: string): void {
	try {
		let path = paths.authFile()
		let created = !existsSync(path)
		let data = created ? liveFiles.liveFile(path, {} as Record<string, any>, { mode: 0o600, watch: false }) : auth.store()
		if (name === 'anthropic' || name === 'openai') {
			// A provider may have subscription accounts: adding its API key must
			// not discard their refresh tokens. Re-entering the key replaces it.
			let entries = data[name] === undefined ? [] : Array.isArray(data[name]) ? data[name] : [data[name]]
			let existing = entries.findIndex((entry: any) => entry?.apiKey && !entry?.accessToken)
			if (existing < 0) entries.push({ apiKey: key })
			else entries[existing] = { ...entries[existing], apiKey: key }
			data[name] = entries
		} else data[name] = { apiKey: key }
		liveFiles.save(data)
		if (created) liveFiles.close(data)
	} finally {
		auth.state.logins++
	}
}

export const apiKeys = { get, save }
