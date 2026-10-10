// Display-only arrivals. Call only at creation, never while reopening:
// the ordinary output record is the durable choice shared by both clients.
import { mkdirSync } from 'fs'
import { clock } from './clock.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { profile } from './profile.ts'

type Period = 'neutral' | 'morning' | 'afternoon' | 'evening'

const pool: Record<Period, string[]> = {
	neutral: [
		'Hello.',
		'Hello. I am ready when you are.',
		'Welcome. What shall we work on?',
		'Good to see you.',
		'Hello again.',
		'I am here. What do you have in mind?',
		'Ready for your next request.',
		'Welcome. Where shall we begin?',
		'Hello. What needs attention?',
		'I am ready to help.',
		'Hello. What would you like to do?',
		'Welcome back.',
		'At your service.',
		'Hello. What is on the agenda?',
		'Ready when you are.',
		'Hello. We can begin whenever you like.',
		'Welcome. Take your time.',
		'Hello. What is next?',
		'Hello, {name}.',
		'Welcome, {name}.',
		'Good to see you, {name}.',
		'Hello, {name}. What shall we work on?',
		'I am here, {name}.',
		'Ready when you are, {name}.',
		'Hello again, {name}.',
		'Welcome, {name}. What do you have in mind?',
	],
	morning: [
		'Good morning.',
		'Good morning. What shall we do today?',
		'Good morning. I am ready to help.',
		'Hello. How is your morning going?',
		'Good morning. Where shall we begin?',
		'Good morning, {name}.',
		'Good morning, {name}. What is on the agenda?',
		'Hello, {name}. What shall we work on this morning?',
	],
	afternoon: [
		'Good afternoon.',
		'Good afternoon. What would you like to work on?',
		'Good afternoon. I am here to help.',
		'Hello. How is your afternoon going?',
		'Good afternoon. What needs attention?',
		'Good afternoon, {name}.',
		'Good afternoon, {name}. What is next?',
		'Hello, {name}. What shall we work on this afternoon?',
	],
	evening: [
		'Good evening.',
		'Good evening. What do you have in mind?',
		'Good evening. Ready when you are.',
		'Hello. How is your evening going?',
		'Good evening. What shall we work on?',
		'Good evening, {name}.',
		'Good evening, {name}. What needs attention?',
		'Hello, {name}. What shall we work on this evening?',
	],
}

function period(timezone?: string, now = clock.now()): Period {
	// An absent or invalid profile zone must not fall back to the host's.
	if (!timezone || !profile.timezone(timezone)) return 'neutral'
	let hour = Number(new Intl.DateTimeFormat('en', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(now))
	return hour >= 7 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'afternoon' : hour >= 18 && hour < 23 ? 'evening' : 'neutral'
}

function name(value?: string): string | undefined {
	// Profile content is data, not terminal commands or Markdown. Refuse
	// control/bidi characters rather than trying to repair escape sequences.
	let text = profile.value(value)
	if (!text || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) return undefined
	return text.replace(/[\\`*_[\]()#|>&!/-]/g, '\\$&')
}

function choose(text: string, previous?: string): string {
	let name = greetings.name(profile.field(text, 'Name'))
	let period = greetings.period(profile.field(text, 'Timezone'))
	let candidates = [...pool.neutral, ...(period === 'neutral' ? [] : pool[period])]
		.filter((text) => name !== undefined || !text.includes('{name}'))
		.map((text) => text.replace('{name}', () => name ?? ''))
		.filter((text) => text !== previous)
	return candidates[Math.floor(greetings.random() * candidates.length)]!
}

function open(id: string): void {
	let meta = sessions.open(id)
	if (meta.model.startsWith('hal/') || (meta.owner && meta.spawn !== 'interactive') || history.readSync(id).length) return
	mkdirSync(paths.stateDir(), { recursive: true })
	let previous = liveFiles.liveFile<{ last?: string }>(`${paths.stateDir()}/greetings.ason`, {}, { watch: false, mode: 0o600 })
	try {
		if (previous.last !== undefined && typeof previous.last !== 'string') throw new Error('greetings.ason: invalid last greeting')
		let text = greetings.choose(profile.text(), previous.last)
		history.append(id, { type: 'output', text, synthetic: true })
		previous.last = text
	} finally {
		liveFiles.close(previous)
	}
}

export const greetings = { period, name, choose, open, random: (): number => Math.random() }
