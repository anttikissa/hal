// hal/intro (task vc): the first-run guide, a scripted model that asks
// with forms. It keeps no step counter: its own durable messages mark a
// run's start (the greeting) and the save, answer records the rest.
import { existsSync } from 'fs'
import { resolve } from 'path'
import { forms, type Answers, type Form } from '../common/forms.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { settings } from '../common/settings.ts'
import { apiKeys } from './api-keys.ts'
import { auth } from './auth.ts'
import { clients } from './clients.ts'
import { config } from './config.ts'
import { liveFiles } from './live-file.ts'
import { models } from './models.ts'
import { modelsDev } from './models-dev.ts'
import { paths } from './paths.ts'
import { profile } from './profile.ts'
import { slash } from './slash.ts'
import type { Reply } from './synthetic.ts'

type Entry = Record<string, any>

const greeting = 'Hello — I am HAL 9001, your personal agent harness. You can call me Hal.'
const saved = 'I saved your answers to'
const closing = "You're all set."
const subscriptions = 'Hal works with your Claude, ChatGPT and OpenCode Go subscriptions: /login signs in. API keys work too, in environment variables or through /login.'
const yesNo = (name: string, text: string): Form => ({ text, fields: [{ type: 'choice', name, options: ['Yes', 'No'], initial: 0 }] })
const words = ['no', 'one', 'two', 'three', 'four', 'five']

function answered(records: HistoryRecord[], field: string): string | undefined {
	for (let i = records.length - 1; i >= 0; i--) {
		let record = records[i]!
		if (record.type === 'answer' && Object.hasOwn(record.answers, field)) return record.answers[field]
		// Escape skips an intro question: it reads as an empty answer.
		if (record.type === 'answer' && record.cancelled && records.some((q) => q.type === 'question' && q.id === record.question && q.form.fields.some((f) => f.name === field))) return ''
	}
	return undefined
}

// Whether any question asking `field` got an answer, even a secret one
// (kept out of history) or a skip.
function replied(records: HistoryRecord[], field: string): boolean {
	return records.some((a) => a.type === 'answer' && records.some((q) => q.type === 'question' && q.id === a.question && q.form.fields.some((f) => f.name === field)))
}

function said(records: HistoryRecord[], text: string): boolean {
	return records.some((r) => r.type === 'assistant' && r.block.type === 'text' && r.block.text.includes(text))
}

// The question the last answer to `field` answered.
function asked(records: HistoryRecord[], field: string): Form | undefined {
	let answer = records.findLast((r) => r.type === 'answer' && Object.hasOwn(r.answers, field))
	let q = answer?.type === 'answer' ? records.findLast((r) => r.type === 'question' && r.id === answer.question) : undefined
	return q?.type === 'question' ? q.form : undefined
}

// Who can use a provider: a nonempty file account (accessToken or
// apiKey) or an environment key. Identities only, never the values;
// malformed credentials fail rather than disappear.
function accounts(): { names: string[]; providers: string[]; stored: number } {
	let data: Entry = existsSync(paths.authFile()) ? auth.store() : {}
	let names: string[] = [], providers: string[] = [], stored = 0
	for (let [kind, label, env] of [
		['anthropic', 'Claude', 'ANTHROPIC_API_KEY'], ['openai', 'ChatGPT', 'OPENAI_API_KEY'],
		['opencode-go', 'OpenCode Go', 'OPENCODE_API_KEY'],
	] as const) {
		let entries = data[kind] === undefined ? [] : Array.isArray(data[kind]) ? data[kind] : [data[kind]]
		for (let entry of entries) if ((typeof entry?.accessToken === 'string' && entry.accessToken.length > 0) || (typeof entry?.apiKey === 'string' && entry.apiKey.length > 0)) {
			names.push(`${label}${entry.email ? ` (${entry.email})` : ''}`)
			providers.push(kind)
			stored++
		}
		if (process.env[env]) { names.push(`${label} (${env})`); providers.push(kind) }
	}
	return { names, providers, stored }
}

// The claude and gpt aliases' current targets a credential can use,
// by display name: label → id.
function choices(providers: string[]): Map<string, string> {
	let out = new Map<string, string>()
	for (let [alias, family] of [['claude', 'Claude'], ['gpt', 'GPT']] as const) {
		let id = models.resolve(alias).id
		if (id && providers.includes(id.split('/')[0]!)) out.set(modelsDev.displayName(id) ?? family, id)
	}
	return out
}

// The IANA zone matching `text`: the name, then its city, then a
// city beginning with it, then one containing it; case-insensitive.
function findZone(text: string): string | undefined {
	let t = text.trim().toLowerCase().replace(/\s+/g, '_')
	if (!t) return undefined
	// Some ICU builds still list the old city name; both zone IDs are valid.
	let all = Intl.supportedValuesOf('timeZone')
	if (all.includes('Asia/Calcutta') && !all.includes('Asia/Kolkata')) all.push('Asia/Kolkata')
	let city = (z: string) => z.split('/').at(-1)!.toLowerCase()
	return all.find((z) => z.toLowerCase() === t) ?? all.find((z) => city(z) === t) ?? all.find((z) => city(z).startsWith(t)) ?? all.find((z) => z.toLowerCase().includes(t))
}

const cityOf = (zone: string) => zone.split('/').at(-1)!.replace(/_/g, ' ')
const zoneIn = (text: string | undefined) => /\(([^()\s]+)\)(?:\. Correct\?)?$/.exec(text ?? '')?.[1]

// The timezone step: a zone to save, none (unchanged), or a question.
function timezone(run: HistoryRecord[], sessionId?: string): { zone?: string; ask?: Reply } {
	let device = sessionId ? clients.timezone(sessionId) : undefined
	let server = clients.hostZone()
	if (device && device === server && !clients.utcLike(device)) return { zone: device }
	let guess = device ?? (clients.utcLike(server) ? undefined : server)
	if (!guess) return {}
	let confirm = answered(run, 'timezone')
	if (confirm === undefined) return { ask: { ask: yesNo('timezone', `It seems like you are in the ${cityOf(guess)} timezone (${guess}). Correct?`) } }
	if (confirm === '') return {}
	if (confirm === 'Yes') return { zone: zoneIn(intro.asked(run, 'timezone')?.text) ?? guess }
	let picked = answered(run, 'zone')
	let options = [...new Set([device && `This device (${device})`, `The server (${server})`].filter((x): x is string => !!x)), 'Other']
	if (picked === undefined) return { ask: { ask: { text: 'Which timezone should I use?', fields: [{ type: 'choice', name: 'zone', options, initial: 0 }] } } }
	if (picked === '') return {}
	if (picked !== 'Other') return { zone: zoneIn(picked) }
	let city = answered(run, 'city')
	let found = city === undefined ? undefined : intro.findZone(city)
	if (found || city?.trim() === '') return { zone: found }
	return { ask: {
		...(city !== undefined && { say: `I couldn't find a timezone for "${city.trim()}". Try a nearby big city, like Helsinki or New York.` }),
		ask: { text: 'Which city is your timezone named after? (Empty skips.)', fields: [{ type: 'text', name: 'city', placeholder: 'Helsinki' }] },
	} }
}

// Every intro question is skippable: Escape moves on instead of
// pausing a scripted turn that only an answer can continue.
function run(records: HistoryRecord[], answers?: Answers, sessionId?: string): Reply {
	let reply = step(records, answers, sessionId)
	return reply.ask ? { ...reply, ask: { ...reply.ask, skip: true } } : reply
}

function step(records: HistoryRecord[], answers?: Answers, sessionId?: string): Reply {
	let start = records.findLastIndex((r) => r.type === 'assistant' && r.block.type === 'text' && r.block.text.includes(greeting))
	let ask: Form = { text: 'What should I call you? (Optional)', fields: [{ type: 'text', name: 'name', placeholder: 'Dave' }] }
	let hello = (): Reply => ({ say: `${greeting}\n\nI have ${words[3 + (auth.serperKey() ? 0 : 1)]} questions for you.`, ask })
	if (start < 0) return hello()
	let run = records.slice(start + 1)
	// Text typed while nothing was asked: the intro can't take it. Text
	// sent while a question was open waited in the inbox; it is let be.
	let typed = run.findLastIndex((r) => r.type === 'user')
	let sent = run.findIndex((r) => r.type === 'inbox' && (run[typed] as { inbox?: string[] }).inbox?.includes(r.id))
	if (sent >= 0 && forms.open(run.slice(0, sent))) typed = -1
	if (typed >= 0) {
		let go = answered(run.slice(typed), 'intro')
		if (go === undefined) {
			let user = run[typed] as HistoryRecord & { type: 'user' }
			let text = user.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ').replace(/\s+/g, ' ').trim()
			if (text.length > 80) text = `${text.slice(0, 79)}…`
			return { say: `I see you typed: "${text}" — but I'm not a language model, so I can't understand you.`, ask: yesNo('intro', 'Continue with the intro?') }
		}
		if (go === 'No') return { say: `Okay, the intro stops here; what you answered stays saved. /model or Ctrl-M picks a model.` }
		if (said(run, closing)) return hello()
	}
	let name = profile.value(answered(run, 'name'))
	if (answered(run, 'name') === undefined) return { ask }
	let say: string[] = []
	if (!said(run, 'Nice to meet you')) say.push(name ? `Nice to meet you, ${name}.` : 'Nice to meet you.')
	let reply = (r: Reply): Reply => ({ ...r, say: [...say, r.say].filter((x) => x).join('\n\n') || undefined })
	let zone = intro.timezone(run, sessionId)
	if (zone.ask) return reply(zone.ask)
	let store = (fields: Parameters<typeof profile.save>[0]) => {
		if (!Object.values(fields).some((v) => profile.value(v))) return
		profile.save(fields)
		if (!said(run, saved)) say.push(`${saved} ${resolve(profile.file())}. You can edit it to update your personal preferences.`)
	}
	if (!said(run, saved)) store({ Name: name, Timezone: zone.zone })

	let loggedIn = intro.accounts()
	let login = answered(run, 'login')
	// Environment keys alone still get the offer: a subscription may be
	// what the user wants, and they may not know Hal found the key.
	if (!loggedIn.stored && login === undefined) return reply({
		say: `${subscriptions}${loggedIn.names.length ? ` Found: ${loggedIn.names.join(', ')}; Skip uses it.` : ''}`,
		ask: { text: 'Sign in now?', fields: [{ type: 'choice', name: 'login', options: ['/login claude', '/login chatgpt', '/login opencode', 'Skip'], initial: 0 }] },
	})
	if (!loggedIn.stored && login?.startsWith('/login ') && !run.some((r) => r.type === 'command' && r.text === login)) {
		// Let the intro turn end, paused, before the command opens its form.
		if (sessionId) setTimeout(() => slash.command(sessionId, login, { name: 'login', args: login.slice('/login '.length) }), 0)
		return reply({ say: `Starting ${login}. The intro goes on once you are signed in; Enter continues it anytime.`, pause: 'waiting for /login' })
	}

	let options = intro.choices(loggedIn.providers)
	let chosen = answered(run, 'model')
	if (options.size && chosen === undefined) return reply({
		say: `Available logins: ${loggedIn.names.join(', ')}.${said(run, subscriptions) ? '' : ` ${subscriptions}`}`,
		ask: { text: 'Which model should Hal use?', fields: [{ type: 'choice', name: 'model', options: [...options.keys(), 'Other'], initial: 0 }] },
	})
	let model = chosen === undefined ? undefined : options.get(chosen) ?? [...options.values()].find((id) => id.startsWith(/^claude/i.test(chosen) ? 'anthropic/' : /^gpt/i.test(chosen) ? 'openai/' : '-'))

	let search = answered(run, 'search')
	if (!auth.serperKey() && search === undefined) return reply({
		say: 'I recommend using Serper for web search results ([serper.dev](https://serper.dev/signup)) - free tier goes a long way.',
		ask: { text: 'Set up a Serper web search key?', fields: [{ type: 'choice', name: 'search', options: ['Yes', 'Maybe later'], initial: 0 }] },
	})
	// An empty key or Escape skips: the step must never trap the user.
	if (search === 'Yes' && !auth.serperKey()) {
		// Secrets stay out of history: only this turn's answers hold the key.
		let key = answers?.key ?? (replied(run, 'key') ? '' : undefined)
		if (key === undefined) return reply({ ask: { text: 'Paste your Serper API key (it will not be shown or saved in conversation history). Empty skips.', fields: [{ type: 'secret', name: 'key', label: 'Serper API key' }] } })
		if (key.trim()) apiKeys.save('serper', key.trim())
		else if (answers?.key !== undefined || !replied(run, 'language')) say.push('Skipped web search for now.')
	}
	// Language comes last: the scripted intro can't switch language
	// mid-way, so asking earlier would promise what it can't do.
	let language = answered(run, 'language')
	if (language === undefined) return reply({ ask: { text: 'Any language or tone preferences? (E.g. "US English; spaces around em dash; friendly but concise")', fields: [{ type: 'text', name: 'language' }] } })
	store({ 'Language preference': language })
	if (model) {
		config.init()
		config.state.data!.model = model
		liveFiles.save(config.state.data!)
		if (sessionId) slash.change(sessionId, { model })
	}
	let now = model ? `This tab now uses ${chosen}, also the default for new tabs.`
		: !loggedIn.names.length ? 'No model can answer yet: after /login, /model or Ctrl-M picks one.'
		: 'This tab still runs the intro: /model or Ctrl-M picks any model.'
	// Not signed in (environment keys aside): the close always says how.
	if (!loggedIn.stored) now += "\n\nYou're not signed in: /login signs in with your Claude, ChatGPT or OpenCode Go subscription, or adds an API key."
	return reply({ say: `${closing} A few tips:\n- Escape pauses a turn; Alt-Enter queues a message for later.\n- /help lists commands and /keys lists shortcuts.\n- The web client is at ${settings.webUrl()}.\n\n${now}` })
}

export const intro = { run, answered, asked, accounts, choices, findZone, timezone }
