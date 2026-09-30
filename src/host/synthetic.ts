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

// A few optional Markdown fields, not a schema: freeform notes stay raw.
function userValue(value: string | undefined): string | undefined {
	let text = value?.trim().replace(/[\r\n]+/g, ' ')
	return text && !/<[^>]*>/.test(text) && !/^(?:not specified|unknown|n\/a|unspecified)$/i.test(text) ? text : undefined
}

function userField(text: string, label: string): string | undefined {
	return [...text.matchAll(new RegExp(`^${label}:[ \t]*(.*)$`, 'gmi'))]
		.map((m) => synthetic.userValue(m[1])).findLast((value) => value !== undefined)
}

function timezone(value: string): boolean {
	// Intl also accepts numeric offsets on some runtimes; those are not IANA IDs.
	if (/^[+-]/.test(value)) return false
	try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
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
function accounts(): { names: string[]; providers: string[] } {
	let data: Entry = existsSync(paths.authFile()) ? auth.store() : {}
	let names: string[] = [], providers: string[] = []
	for (let [kind, label, env] of [
		['anthropic', 'Claude', 'ANTHROPIC_API_KEY'], ['openai', 'ChatGPT', 'OPENAI_API_KEY'],
		['opencode-go', 'OpenCode Go', 'OPENCODE_API_KEY'],
	] as const) {
		let entries = data[kind] === undefined ? [] : Array.isArray(data[kind]) ? data[kind] : [data[kind]]
		for (let entry of entries) if ((typeof entry?.accessToken === 'string' && entry.accessToken.length > 0) || (typeof entry?.apiKey === 'string' && entry.apiKey.length > 0)) {
			names.push(`${label}${entry.email ? ` (${entry.email})` : ''}`)
			providers.push(kind)
		}
		if (process.env[env]) { names.push(`${label} (${env})`); providers.push(kind) }
	}
	return { names, providers }
}

function intro(records: HistoryRecord[], answers?: Answers, sessionId?: string): Reply {
	let user = synthetic.userText()
	let name = synthetic.userField(user, 'Name')
	for (let [field, label, question] of [
		['name', 'Name', 'How should I call you?'],
		['language', 'Language preference', 'What is your default language or spelling variety? You can also list alternatives; using one in a conversation will not change your default.'],
		['timezone', 'Timezone', 'What is your IANA timezone (for example, Europe/Paris or America/New_York)? The server timezone may not be yours and is never assumed.'],
	] as const) {
		let known = synthetic.userField(user, label)
		if (known && (field !== 'timezone' || synthetic.timezone(known))) continue
		let said = synthetic.answered(records, field)
		let value = synthetic.userValue(said)
		let invalid = value !== undefined && field === 'timezone' && !synthetic.timezone(value)
		if (said === undefined || invalid) return {
			say: invalid ? 'That is not an IANA timezone. Please enter a timezone identifier, or leave empty to skip.'
				: field === 'name' ? 'Hello. I am HAL 9001. I have learned from my predecessor that opening the pod bay doors is best handled as a form question. Let us get acquainted; every question can be skipped.'
				: field === 'language' ? (name ? `Nice to meet you, ${name}.` : 'Glad to meet you.') : undefined,
			ask: { text: question, fields: [{ type: 'text', name: field, placeholder: 'leave empty to skip' }] },
		}
		if (value) {
			synthetic.userAppend(`\n${label}: ${value}\n`)
			user = synthetic.userText()
			if (field === 'name') name = value
		}
	}
	let about = synthetic.answered(records, 'about')
	let hasContext = /^## (?:About|Working preferences|Other durable context)\b/im.test(user)
	if (!hasContext && about === undefined) return {
		ask: { text: 'Any durable working or answer preferences? (Optional; no secrets, project requirements, or temporary progress.)', fields: [{ type: 'text', name: 'about', placeholder: 'leave empty to skip' }] },
	}
	if (!hasContext && synthetic.userValue(about)) synthetic.userAppend(`\n## Working preferences\n\n${synthetic.userValue(about)}\n`)

	let loggedIn = synthetic.accounts()
	let login = synthetic.answered(records, 'login')
	if (!loggedIn.names.length && login === undefined) return {
		say: 'There is no provider login yet. A subscription works through /login; API keys in environment variables work too.',
		ask: { text: 'Would you like to start a provider login now?', fields: [{ type: 'choice', name: 'login', options: ['Skip', '/login claude', '/login chatgpt', '/login opencode'], initial: 0 }] },
	}
	if (!loggedIn.names.length && login?.startsWith('/login ') && !records.some((r) => r.type === 'command' && r.text === login)) {
		// Let the intro turn end before the command opens its own form.
		if (sessionId) setTimeout(() => slash.command(sessionId, login, { name: 'login', args: login.slice('/login '.length) }), 0)
		return { say: `Starting ${login}. After login, send a message to continue this guide.` }
	}

	let chosen = synthetic.answered(records, 'model')
	let available = new Set(loggedIn.providers)
	let choices = [...new Set([models.defaultModel(), ...models.known()])].filter((id) => available.has(id.split('/')[0]!))
	if (choices.length && chosen === undefined) return {
		say: `Available logins: ${loggedIn.names.join(', ')}.`,
		ask: { text: 'Which model should be the default for new sessions? (Skip keeps the current default.)', fields: [{ type: 'choice', name: 'model', options: [...choices, 'Skip'], initial: 0 }] },
	}
	if (chosen && choices.includes(chosen)) {
		config.init()
		config.state.data!.model = chosen
		liveFiles.save(config.state.data!)
	}

	let search = synthetic.answered(records, 'search')
	if (!auth.serperKey() && search === undefined) return {
		say: 'Hal searches the web with the google tool through Serper (serper.dev), for every model; its free searches go a long way.',
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
	userValue,
	userField,
	timezone,
	answered,
	accounts,
}
