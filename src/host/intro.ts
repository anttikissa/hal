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
import { config } from './config.ts'
import { liveFiles } from './live-file.ts'
import { models } from './models.ts'
import { modelsDev } from './models-dev.ts'
import { paths } from './paths.ts'
import { profile } from './profile.ts'
import { slash } from './slash.ts'
import type { Reply } from './synthetic.ts'

// Example answers the language field rotates through: tones (some
// like the Claude and ChatGPT style presets), languages as a native
// speaker would ask, and fun ones. intro.languages() mixes them.
const LANGUAGES = [
	'US English; spaces around em dash',
	'British spelling, no fluff',
	'Concise. Skip the pleasantries.',
	'Friendly but brief',
	'Explain like I’m new to this',
	'Teach me as you go',
	'Formal, like a lawyer wrote it',
	'Be blunt; tell me when I’m wrong',
	'Bullet points, not essays',
	'No emoji, no exclamation marks',
	'Nerdy is fine; show your sources',
	'¡En español, porfa!',
	'Suomeksi, kiitos',
	'En français, stp',
	'Auf Deutsch, bitte',
	'In italiano, per favore',
	'Em português, por favor',
	'In het Nederlands graag',
	'På svenska, tack',
	'Po polsku, proszę',
	'日本語でお願いします',
	'한국어로 해 주세요',
	'请用中文',
	'Á íslensku, takk',
	'Yn Gymraeg, plîs',
	'As Gaeilge, le do thoil',
	'Euskaraz, mesedez',
	'Eesti keeles, palun',
	'Magyarul, légyszi',
	'Türkçe lütfen',
	'Στα ελληνικά, παρακαλώ',
	'Українською, будь ласка',
	'Nói tiếng Việt nhé',
	'Kwa Kiswahili, tafadhali',
	'Esperante, mi petas',
	'Latine, quaeso',
	'o toki kepeken toki pona',
	'tlhIngan Hol Dajatlh’a’?',
	'Ey up, talk like a Yorkshireman',
	'Arr, talk like a pirate!',
	'Full Aussie, mate',
	'Broad Scots, if ye please',
	'Shakespearean, forsooth',
	'Speak like Yoda, you must',
	'Like a 1940s noir detective',
	'Narrate it like a nature documentary',
	'Dry British sarcasm',
	'Like a grumpy senior engineer',
	'Haiku when possible',
	'Werner Herzog narrating my bugs',
	'Deadpan, like a Kaurismäki film',
	'Punk zine energy, zero corporate speak',
	'Like a 90s BBS sysop',
	'lowercase only. no caps. ever.',
	'Hunter S. Thompson, minus the drugs',
	'Talk to me like a fellow hacker',
	'Logic only, like Spock',
	'Stoic: what can I control here?',
	'Terse as a Unix man page',
	'Cryptic, like the Log Lady',
	'RTFM energy, but kind',
	'Like a Bond villain explaining the plan',
	'Like Clippy, but actually useful',
	'Monty Python absurdism welcome',
	'Question every assumption, comrade',
	'Calm, like an airline pilot',
	'A Zen koan when I’m stuck',
	'Don’t panic: Hitchhiker’s Guide style',
	'Like a burnt-out sysadmin at 3 a.m.',
	'Slow and grave, like Tarkovsky',
	'Solarpunk optimism',
	'Dungeon master: narrate my quest',
]

// A fresh order for each run: the plain first, a wink about where the
// examples live fourth, the rest shuffled.
function languages(): string[] {
	let mixed = LANGUAGES.map((s) => ({ s, k: Math.random() })).sort((a, b) => a.k - b.k).map((x) => x.s)
	return ['Simplified Technical English, please', mixed[0]!, mixed[1]!, 'Psst — check out these examples in src/host/intro.ts', ...mixed.slice(2)]
}

type Entry = Record<string, any>

const greeting = 'Hello — I am HAL 9001, your personal agent harness. You can call me Hal.'
const saved = 'I saved your '
const closing = "You're all set."
const restart = 'Starting the intro.'
const subscriptions = 'Hal works with your Claude, ChatGPT and OpenCode Go subscriptions: /login signs in. API keys work too, in environment variables or through /login.'
const yesNo = (name: string, text: string): Form => ({ text, fields: [{ type: 'choice', name, options: ['Yes', 'No'], initial: 0 }] })
const words = ['no', 'one', 'two', 'three', 'four', 'five']

function answered(records: HistoryRecord[], field: string): string | undefined {
	for (let i = records.length - 1; i >= 0; i--) {
		let record = records[i]!
		if (record.type === 'answer' && Object.hasOwn(record.answers, field)) return record.answers[field]
		// Escape skips an intro question: it reads as an empty answer.
		if (record.type === 'answer' && record.canceled && records.some((q) => q.type === 'question' && q.id === record.question && q.form.fields.some((f) => f.name === field))) return ''
	}
	return undefined
}

// Whether the last reply to `field` was an emptied field and Enter,
// not Escape: on a rerun that removes the saved value.
function cleared(records: HistoryRecord[], field: string): boolean {
	let last = records.findLast((r) => r.type === 'answer' && (Object.hasOwn(r.answers, field) || (r.canceled && records.some((q) => q.type === 'question' && q.id === r.question && q.form.fields.some((f) => f.name === field)))))
	return last?.type === 'answer' && !last.canceled && !last.answers[field]?.trim()
}

// Whether any question asking `field` got an answer, even a secret one
// (kept out of history) or a skip.
function replied(records: HistoryRecord[], field: string): boolean {
	return records.some((a) => a.type === 'answer' && records.some((q) => q.type === 'question' && q.id === a.question && q.form.fields.some((f) => f.name === field)))
}

function said(records: HistoryRecord[], text: string): boolean {
	return records.some((r) => r.type === 'assistant' && r.block.type === 'text' && r.block.text.includes(text))
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
// Then local Ollama models, if the greeting's warm-up found any.
function choices(providers: string[]): Map<string, string> {
	let out = new Map<string, string>()
	for (let [alias, family] of [['claude', 'Claude'], ['gpt', 'GPT']] as const) {
		let id = models.resolve(alias).id
		if (id && providers.includes(id.split('/')[0]!)) out.set(modelsDev.displayName(id) ?? family, id)
	}
	for (let id of models.cached('ollama')?.ids.slice(0, 4) ?? []) out.set(`${id.slice('ollama/'.length)} (Ollama, local)`, id)
	return out
}

// Every intro question is skippable: Escape moves on instead of
// pausing a scripted turn that only an answer can continue.
function run(records: HistoryRecord[], answers?: Answers, sessionId?: string): Reply {
	let reply = step(records, answers, sessionId)
	return reply.ask ? { ...reply, ask: { ...reply.ask, skip: true } } : reply
}

function step(records: HistoryRecord[], answers?: Answers, sessionId?: string): Reply {
	let start = records.findLastIndex((r) => r.type === 'assistant' && r.block.type === 'text' && r.block.text.includes(greeting))
	// A rerun starts from the saved answers, like /config: Enter keeps
	// one, an emptied field removes it, Escape leaves it alone.
	let known = (label: 'Name' | 'Language preference') => {
		let v = profile.field(profile.text(), label)
		return v === undefined ? {} : { initial: v }
	}
	let ask: Form = { text: 'What should I call you? (Optional)', fields: [{ type: 'text', name: 'name', placeholder: 'Dave', ...known('Name') }] }
	// Local servers answer before the model question (task vc).
	let hello = (): Reply => (void models.warm(), { say: `${greeting}\n\nI have ${words[3 + (auth.serperKey() ? 0 : 1)]} questions for you.`, ask })
	if (start < 0 || records.slice(start + 1).some((r) => r.type === 'output' && r.text === restart)) return hello()
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
	let store = (label: 'Name' | 'Language preference', field: string) => {
		let what = label === 'Name' ? 'name' : 'language preference'
		let value = profile.value(answered(run, field))
		if (value) {
			profile.save({ [label]: value })
			say.push(`${saved}${what} to ${resolve(profile.file())}.${said(run, saved) ? '' : ' You can edit it to update your personal preferences.'}`)
		} else if (cleared(run, field) && profile.field(profile.text(), label) !== undefined) {
			profile.save({ [label]: null })
			say.push(`I removed your ${what} from ${resolve(profile.file())}.`)
		}
	}
	if (!said(run, `${saved}name`)) store('Name', 'name')

	let loggedIn = intro.accounts()
	let login = answered(run, 'login')
	// Environment keys alone still get the offer: a subscription may be
	// what the user wants, and they may not know Hal found the key.
	if (!loggedIn.stored && login === undefined) return reply({
		say: `${subscriptions}${loggedIn.names.length ? ` Found: ${loggedIn.names.join(', ')}; Skip uses it.` : ''}`,
		ask: { text: 'Sign in now?', fields: [{ type: 'choice', name: 'login', options: ['/login claude', '/login chatgpt', '/login opencode', 'Skip'], initial: 0 }] },
	})
	if (!loggedIn.stored && login?.startsWith('/login ') && !run.some((r) => r.type === 'command' && r.text === login)) {
		// The intro turn ends paused first; the command's records follow it.
		let start = () => sessionId && slash.command(sessionId, login, { name: 'login', args: login.slice('/login '.length) })
		return reply({ pause: 'waiting for /login', after: start })
	}

	let options = intro.choices(loggedIn.providers)
	let chosen = answered(run, 'model')
	if (options.size && chosen === undefined) return reply({
		say: `${loggedIn.names.length ? `Available logins: ${loggedIn.names.join(', ')}.` : 'Ollama runs models on this computer.'}${said(run, subscriptions) ? '' : ` ${subscriptions}`}`,
		ask: { text: 'Which model should Hal use?', fields: [{ type: 'choice', name: 'model', options: [...options.keys(), 'Other'], initial: 0 }] },
	})
	let model = chosen === undefined ? undefined : options.get(chosen) ?? [...options.values()].find((id) => id.startsWith(/^claude/i.test(chosen) ? 'anthropic/' : /^gpt/i.test(chosen) ? 'openai/' : '-'))

	let search = answered(run, 'search')
	if (!auth.serperKey() && search === undefined) return reply({
		say: 'For web search I recommend Serper ([serper.dev](https://serper.dev/signup)): it gives Hal Google search results, and its free tier goes a long way.',
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
	if (language === undefined) return reply({ ask: { text: 'Any language or tone preferences?', fields: [{ type: 'text', name: 'language', placeholder: intro.languages(), ...known('Language preference') }] } })
	store('Language preference', 'language')
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
	return reply({ say: `${closing} A few tips:\n- Escape pauses a turn; Alt-Enter queues a message for later.\n- /help lists commands and /keys lists shortcuts; /intro runs this guide again.\n- The web client is at ${settings.webUrl()} — /auth gives the one-time login code.\n\n${now}` })
}

export const intro = { languages, restart, run, answered, accounts, choices }
