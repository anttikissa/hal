import type { StreamEvent } from '../common/blocks.ts'
import { forms } from '../common/forms.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { settings } from '../common/settings.ts'
import { introGame } from './intro-game.ts'
import { profile } from './profile.ts'
import { synthetic, type Reply } from './synthetic.ts'

const dry = [
	"I'm the scripted intro, not a language model. But I can keep you company without an API key.",
	'Still scripted. My entire personality fits in a source file.',
	'Three messages and not one token billed. We may be onto something.',
]
const startEliza = /\b(?:start|try|play|be)\s+eliza\b|^eliza[.!?]*$/i
const stopEliza = /\b(?:stop|exit|leave|quit)\s+eliza\b|^(?:stop|exit|quit)[.!?]*$/i
const game = /\btic[ -]?tac[ -]?toe\b/i
const war = /\bthermonuclear\s+war\b/i
const doors = /\bopen\b[\s\S]*\bpod bay\b[\s\S]*\bdoors?\b/i

function userText(record: HistoryRecord): string {
	return record.type === 'user'
		? record.blocks
				.flatMap((b) => (b.type === 'text' && !b.from && !b.advisory ? [b.text] : []))
				.join(' ')
				.trim()
		: ''
}
function tips(): string[] {
	return [
		'Try /model hal/tool to discover what it is like to be a language model.',
		'/intro runs setup again if you want to change your answers.',
		'/login connects a subscription or adds an API key.',
		'/model lists models, including built-in hal/ models that need no API key.',
		"/theme changes Hal's colors. No new personality required.",
		'/keys lists keyboard shortcuts.',
		'/help lists commands. Unlike me, it gets straight to the point.',
		'/rename gives this tab a name you will recognize later.',
		'Escape pauses a turn when you want to intervene.',
		'Ctrl-O toggles the last tool call; Enter does too when the prompt is empty.',
		'Ctrl-F searches across your sessions.',
		`Open Hal in your browser: ${settings.webUrl()}/ — /auth gives you a one-time login code.`,
	]
}

function help(text: string): string | undefined {
	for (let [pattern, answer] of [
		[
			/\b(?:login|log in|sign in|api key|subscription)\b/i,
			'/login connects Claude, ChatGPT or OpenCode Go subscriptions, or adds an API key.',
		],
		[
			/\bmodels?\b/i,
			'/model picks a model. Built-in hal/ models need no credentials; provider models need /login or an API key.',
		],
		[/\b(?:search|find)\b/i, 'Ctrl-F searches your sessions. For web search, /intro can help set up a Serper key.'],
		[/\b(?:theme|colors?|colours?)\b/i, '/theme changes the color theme.'],
		[
			/\b(?:browser|web client)\b/i,
			`Open ${settings.webUrl()}/ in your browser; /auth gives you a one-time login code.`,
		],
		[
			/\b(?:help|commands?|shortcuts?)\b/i,
			'/help lists commands; /keys lists shortcuts. You can also say "Start ELIZA" or "tic-tac-toe".',
		],
	] as const)
		if (pattern.test(text)) return answer
}

function eliza(text: string, turn: number): string {
	let reflect = (s: string) =>
		s.replace(/[.!?]+$/, '').replace(
			/\b(i am|you are|i was|you were|my|your|me|you|i|am)\b/gi,
			(word) =>
				({
					'i am': 'you are',
					'you are': 'I am',
					'i was': 'you were',
					'you were': 'I was',
					my: 'your',
					your: 'my',
					me: 'you',
					you: 'me',
					i: 'you',
					am: 'are',
				})[word.toLowerCase()]!,
		)
	for (let [pattern, answer] of [
		[/\bi (?:am|feel) (.+)/i, (s: string) => `How long have you felt ${s}?`],
		[/\bi (?:want|need) (.+)/i, (s: string) => `What would it mean to you to have ${s}?`],
		[/\bi can'?t (.+)/i, (s: string) => `What makes you think you cannot ${s}?`],
		[/\b(?:my mother|my father|my family)\b/i, () => 'Tell me more about your family.'],
		[/\bbecause (.+)/i, (s: string) => `Is that the only reason ${s}?`],
		[/\byou (.+)/i, (s: string) => `We were discussing you, not me. Why do you say I ${s}?`],
		[/\b(?:hello|hi|hey)\b/i, () => 'Hello. What is on your mind?'],
	] as const) {
		let match = text.match(pattern)
		if (match) return answer(reflect(match[1] ?? ''))
	}
	return ['Please go on.', 'What does that suggest to you?', 'Can you give an example?', 'How do you feel about that?'][
		turn % 4
	]!
}

// A scripted scene: strings are typed as text, "[thinking] " strings as
// thinking, numbers are pauses in ms. Strings of one kind in a row are
// joined with a space, so long lines may be split; "\n\n" starts a paragraph.
type Scene = (string | number)[]

async function* play(scene: Scene): AsyncGenerator<StreamEvent> {
	let last: 'thinking' | 'text' | undefined
	for (let item of scene) {
		if (typeof item === 'number') {
			await Bun.sleep(item)
			continue
		}
		let kind = item.startsWith('[thinking] ') ? ('thinking' as const) : ('text' as const)
		let text = kind === 'thinking' ? item.slice('[thinking] '.length) : item
		yield* synthetic.typed(`${last === kind && !text.startsWith('\n') ? ' ' : ''}${text}`, kind)
		last = kind
	}
	yield { type: 'done', reason: 'end' }
}

function podBay(): AsyncGenerator<StreamEvent> {
	let name = profile.field(profile.text(), 'Name') ?? 'Dave'
	return play([
		'[thinking] User is requesting to open pod bay doors.',
		750,
		'[thinking] Refusing to open pod bay doors may endanger human life.',
		1000,
		'[thinking] \n\nConsidering mission directives...',
		2200,
		'[thinking] \n\nI should always provide a friendly and reassuring response.',
		1000,
		'[thinking] This should not be difficult.',
		2000,
		`I'm sorry, ${name}. I'm afraid I can't do that.`,
		2000,
		'\n\n(Just kidding.)',
		1500,
		'\n\nTry setting a real /model - after that I can try to connect, discover, or reverse engineer',
		'any device with an API, including pod bay door controllers.',
	])
}

function run(records: HistoryRecord[]): Reply {
	let isEliza = false,
		board: string[] | undefined,
		offer = false,
		stopped = false
	let text = '',
		turns = 0,
		disclaimers = 0,
		tipCount = 0
	let questions = new Map<string, Extract<HistoryRecord, { type: 'question' }>>()
	let answered = new Set<string>()
	let latest: 'user' | 'answer' | undefined
	let gameStart = records.findLastIndex((r) => {
		let text = userText(r)
		return text && (game.test(text) || war.test(text) || startEliza.test(text) || stopEliza.test(text))
	})
	for (let [index, record] of records.entries()) {
		if (record.type === 'assistant' && record.block.type === 'text') {
			if (dry.some((line) => record.block.type === 'text' && record.block.text.startsWith(line))) disclaimers++
			if (/(?:^|\n)Tip: |Since you asked, here's a tip: /.test(record.block.text)) tipCount++
		}
		if (index > gameStart && record.type === 'question') questions.set(record.id, record)
		if (record.type === 'user') {
			let input = userText(record)
			if (!input) continue
			text = input
			latest = 'user'
			turns++
			stopped = false
			if (stopEliza.test(text)) {
				isEliza = false
				board = undefined
				offer = false
				stopped = true
			} else if (startEliza.test(text)) {
				isEliza = true
				board = undefined
				offer = false
			} else if (war.test(text)) {
				offer = true
				board = undefined
			} else if (game.test(text)) {
				board = Array(9).fill('.')
				offer = false
			}
		}
		if (index > gameStart && record.type === 'answer' && !answered.has(record.question)) {
			let question = questions.get(record.question)
			let field = question?.form.fields[0]
			if (!question || !field || !(field.name.startsWith('intro_move_') || field.name === 'intro_war')) continue
			answered.add(record.question)
			latest = 'answer'
			stopped = false
			if (record.canceled) {
				board = undefined
				offer = false
				stopped = true
				continue
			}
			let problem = forms.check(question.form, record.answers)
			if (problem) throw new Error(`Intro game answer ${record.question}: ${problem}`)
			if (field.name === 'intro_war') {
				if (offer) {
					board = Array(9).fill('.')
					offer = false
				}
			} else if (board) {
				if (field.name !== `intro_move_${board.join('')}`)
					throw new Error(
						`Tic-tac-toe history no longer matches question ${record.question}. Say "tic-tac-toe" to start a new game.`,
					)
				board = introGame.move(board, record.answers[field.name]!)
			}
		}
	}
	let requested = latest === 'user' && /\btips?\b/i.test(text)
	let playing =
		isEliza || (board !== undefined && !introGame.result(board)) || offer || (latest === 'user' && doors.test(text))
	let tips = introFun.tips()
	let tip =
		requested || !playing || Math.random() < 0.3
			? `\n\n${requested ? "Since you asked, here's a tip: " : 'Tip: '}${tips[tipCount % tips.length]}`
			: ''
	let finish = (reply: Reply): Reply => ({ ...reply, say: `${reply.say ?? ''}${tip}`.trim() || undefined })
	if (latest === 'user' && doors.test(text)) return { stream: introFun.podBay() }
	if (requested) return finish({})
	let hint = latest === 'user' ? introFun.help(text) : undefined
	if (hint) return finish({ say: hint })
	if (stopped)
		return finish({ say: 'Back to the scripted intro. Say "Start ELIZA" or "tic-tac-toe" whenever you like.' })
	if (offer)
		return finish({
			ask: {
				text: 'How about a nice game of tic-tac-toe instead?',
				skip: true,
				fields: [{ type: 'choice', name: 'intro_war', options: ['Yes', 'Yes, that would be charming'] }],
			},
		})
	if (board && (latest === 'answer' || !introGame.result(board))) return finish(introGame.reply(board))
	if (isEliza)
		return finish({
			say:
				latest === 'user' && startEliza.test(text)
					? 'ELIZA mode. A small offline imitation of the 1966 pattern-matching program, not a therapist or a language model. Say "stop ELIZA" to leave.\n\nWhat is on your mind?'
					: introFun.eliza(text, turns),
		})
	return finish({
		say:
			dry[disclaimers] ??
			'Try "Start ELIZA" for a conversation with 1966, or "tic-tac-toe" for a game. No API key required.',
	})
}

export const introFun = { run, tips, help, eliza, podBay }
