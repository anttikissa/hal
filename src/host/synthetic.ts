// Scripted models run inside the host. Each answered form is durable in
// history; hal/intro derives its next step from those records and USER.md.
import { appendFileSync, existsSync, readFileSync } from 'fs'
import type { Answers, Form } from '../common/forms.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { settings } from '../common/settings.ts'
import { apiKeys } from './api-keys.ts'
import { auth } from './auth.ts'
import { config } from './config.ts'
import { liveFiles } from './live-file.ts'
import { models } from './models.ts'
import { paths } from './paths.ts'
import { slash } from './slash.ts'

export type Reply = { say?: string; ask?: Form }
export type Synthetic = (records: HistoryRecord[], answers?: Answers, sessionId?: string) => Reply

type Entry = Record<string, any>

function userText(): string {
	let path = `${paths.home()}/USER.md`
	return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

// Never rewrite a user's note. A new file starts with the header; later
// entries append after what the user wrote, even when it was edited.
function userAppend(text: string): void {
	let path = `${paths.home()}/USER.md`
	appendFileSync(path, (existsSync(path) ? '' : '# User\n') + text, { mode: 0o600 })
}

function answered(records: HistoryRecord[], field: string): string | undefined {
	for (let i = records.length - 1; i >= 0; i--) {
		let record = records[i]!
		if (record.type === 'answer' && Object.hasOwn(record.answers, field)) return record.answers[field]
	}
	return undefined
}

// Show identities only, never credential values. The file is loaded via the
// same live store as /login; malformed credentials fail rather than disappear.
function accounts(): string[] {
	let data: Entry = existsSync(paths.authFile()) ? auth.store() : {}
	let out: string[] = []
	for (let [kind, label, env] of [
		['anthropic', 'Claude', 'ANTHROPIC_API_KEY'], ['openai', 'ChatGPT', 'OPENAI_API_KEY'],
		['opencode-go', 'OpenCode Go', 'OPENCODE_API_KEY'],
	] as const) {
		let entries = data[kind] === undefined ? [] : Array.isArray(data[kind]) ? data[kind] : [data[kind]]
		for (let entry of entries) if (typeof entry?.accessToken === 'string' || typeof entry?.apiKey === 'string') out.push(`${label}${entry.email ? ` (${entry.email})` : ''}`)
		if (process.env[env]) out.push(`${label} (${env})`)
	}
	return out
}

function intro(records: HistoryRecord[], answers?: Answers, sessionId?: string): Reply {
	let user = synthetic.userText()
	let name = user.match(/^Name:\s*(.+)$/m)?.[1]?.trim()
	let saidName = synthetic.answered(records, 'name')
	if (!name && saidName === undefined) return {
		say: 'Hello, I am Hal. Let us get acquainted; every question can be skipped.',
		ask: { text: 'How should I call you?', fields: [{ type: 'text', name: 'name', placeholder: 'leave empty to stay nameless' }] },
	}
	if (!name && saidName?.trim()) {
		name = saidName.trim().replace(/[\r\n]+/g, ' ')
		synthetic.userAppend(`\nName: ${name}\n`)
		user = synthetic.userText()
	}
	let about = synthetic.answered(records, 'about')
	if (!/^## About\b/m.test(user) && about === undefined) return {
		say: name ? `Nice to meet you, ${name}.` : 'Glad to meet you.',
		ask: { text: 'What do you mostly work on, and how do you like answers? (Optional; no secrets.)', fields: [{ type: 'text', name: 'about', placeholder: 'leave empty to skip' }] },
	}
	if (!/^## About\b/m.test(user) && about?.trim()) synthetic.userAppend(`\n## About\n\n${about.trim().replace(/[\r\n]+/g, ' ')}\n`)

	let loggedIn = synthetic.accounts()
	let login = synthetic.answered(records, 'login')
	if (!loggedIn.length && login === undefined) return {
		say: 'There is no provider login yet. A subscription works through /login; API keys in environment variables work too.',
		ask: { text: 'Would you like to start a provider login now?', fields: [{ type: 'choice', name: 'login', options: ['Skip', '/login claude', '/login chatgpt', '/login opencode'], initial: 0 }] },
	}
	if (!loggedIn.length && login?.startsWith('/login ') && !records.some((r) => r.type === 'command' && r.text === login)) {
		// Let the intro turn end before the command opens its own form.
		if (sessionId) setTimeout(() => slash.command(sessionId, login, { name: 'login', args: login.slice('/login '.length) }), 0)
		return { say: `Starting ${login}. After login, send a message to continue this guide.` }
	}

	let chosen = synthetic.answered(records, 'model')
	let choices = [...new Set([models.defaultModel(), ...models.known().filter((id) => !id.startsWith('hal/'))])]
	if (chosen === undefined) return {
		say: loggedIn.length ? `Available logins: ${loggedIn.join(', ')}.` : 'You can use /login later, or supply a provider API key.',
		ask: { text: 'Which model should be the default for new sessions? (Skip keeps the current default.)', fields: [{ type: 'choice', name: 'model', options: [...choices, 'Skip'], initial: 0 }] },
	}
	if (chosen && choices.includes(chosen)) {
		config.init()
		config.state.data!.model = chosen
		liveFiles.save(config.state.data!)
	}

	let search = synthetic.answered(records, 'search')
	if (!auth.serperKey() && search === undefined) return {
		say: 'Claude models search with their own web_search tool. Other models use the google tool through Serper (serper.dev); its free tier goes a long way.',
		ask: { text: 'Set up a Serper web search key?', fields: [{ type: 'choice', name: 'search', options: ['No', 'Yes'], initial: 0 }] },
	}
	if (search === 'Yes' && !auth.serperKey()) {
		if (!answers?.key?.trim()) return { ask: { text: 'Paste your Serper API key (it will not be shown or saved in conversation history).', fields: [{ type: 'secret', name: 'key', label: 'Serper API key' }] } }
		apiKeys.save('serper', answers.key.trim())
	}
	if (sessionId && chosen && choices.includes(chosen)) slash.change(sessionId, { model: chosen })
	return { say: `You are ready. Escape pauses a turn; Alt-Enter queues a message; /help lists commands and /keys lists shortcuts. The web client is at ${settings.webUrl()}. This tab can use a real model with /model <provider/model>${chosen ? ` (for example, /model ${chosen})` : ''}.` }
}

function find(model: string): Synthetic | undefined {
	return model.startsWith('hal/') ? synthetic.models[model.slice(4)] : undefined
}

export const synthetic = {
	models: { intro } as Record<string, Synthetic>,
	find,
	userText,
	userAppend,
	answered,
	accounts,
}
