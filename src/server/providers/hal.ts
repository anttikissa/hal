import { auth } from '../auth.ts'
import { models } from '../../common/models.ts'
import { providerShared } from './shared.ts'
import { serverModels } from '../models.ts'
import type { ContentBlock, Message, Provider, ProviderRequest, ProviderStreamEvent } from '../../common/protocol.ts'

type ScriptStep =
	| { type: 'text'; text: string }
	| { type: 'delay'; ms: number }
	| { type: 'config'; key: string; value: string }

type ScriptPage = {
	steps: ScriptStep[]
	text: string
	pause: boolean
}

const config = {
	/** Streaming speed for HAL's built-in scripted models. */
	wordsPerSecond: 10,
	tableChunksPerSecond: 60,
}

function introScript(): string {
	const alias = halProvider.introDefaultModel()
	return `Hello. I am HAL 9001, a moderately advanced agent harness and terminal client.<pause for="0.3s"/> You can call me Hal.
Press Enter to continue.
<pause until="enter"/><config key="renderStatus.promptOpacity" value="1"/><config key="renderStatus.helpOpacity" value="1"/>Your controls. You know the drill.<pause for="0.3s"/><config key="renderStatus.statusOpacity" value="1"/>

You are speaking to synthetic model \`hal/intro\`. To work with real models, credentials are required.<pause for="0.3s"/><config key="renderStatus.tabsOpacity" value="1"/>

${halProvider.providerSetupText()}

${halProvider.introModelText(alias)} Change it with \`/model\` or \`Ctrl-M\`.<config key="models.refresh" value="true"/><config key="web.enabled" value="true"/><config key="models.default" value="${alias}"/>`
}

// Sessions whose intro was skipped with Esc: the rest of the script streams at once.
const state = { skipped: new Set<string>() }

// Recommendations are aliases so routine catalog updates do not age the intro.
// Grok's short alias routes through OpenRouter, so its direct key is special.
const suggestions: Record<string, string> = {
	anthropic: 'claude',
	openai: 'gpt',
	google: 'gemini',
	openrouter: 'deepseek',
	// Go's own route, not the OpenRouter alias: the point of the key is to bill the
	// subscription instead of per-token.
	'opencode-go': 'opencode-go/kimi-k3',
}

// How good a first experience each key gives (Sep 2026 coding leaderboards):
// Claude and GPT trade the top spots, DeepSeek V3.2 is a tier down, and the
// gemini alias is a Flash model. Ties are broken at random so users holding
// both frontier keys are split between them.
const priorities: Record<string, number> = {
	anthropic: 10,
	openai: 10,
	openrouter: 8,
	google: 7,
}

// Providers with an API key in the environment, paired with the key names found.
// Only model providers belong here: e.g. Serper's key is for a search tool.
function detectedProviders(): Map<string, string[]> {
	const providers = new Set(['anthropic', 'openai', ...Object.keys(serverModels.state.providers ?? {}), ...Object.keys(providerShared.compatEndpoints)])
	// The loader also accepts NAME_BASE_URL + NAME_API_KEY for custom backends.
	for (const name of Object.keys(process.env)) {
		if (/^[A-Z][A-Z0-9_]*_BASE_URL$/.test(name) && process.env[name]) providers.add(name.slice(0, -9).toLowerCase())
	}
	const found = new Map<string, string[]>()
	for (const provider of providers) {
		const present = auth.envKeyNames(provider).filter((name) => !!process.env[name])
		if (present.length) found.set(provider, present)
	}
	return found
}

// The model the intro hands the session to: the highest-priority detected key,
// otherwise gpt. Subscriptions arrive later via /login.
function introDefaultModel(): string {
	let best: string[] = []
	let bestPriority = 0
	for (const provider of halProvider.detectedProviders().keys()) {
		const priority = halProvider.priorities[provider] ?? 0
		if (priority > bestPriority) {
			best = []
			bestPriority = priority
		}
		if (priority === bestPriority && priority > 0) best.push(halProvider.suggestions[provider]!)
	}
	if (best.length === 0) return 'gpt'
	return best[Math.floor(halProvider.random() * best.length)]!
}

function introModelText(alias: string): string {
	const fullId = models.resolveModel(alias)
	return `I set the default model to \`${alias}\`, aliased to ${fullId} (${models.displayModel(fullId)}).`
}

function providerSetupText(): string {
	// One env var can belong to several providers (OPENCODE_API_KEY covers both
	// OpenCode Zen and Go). Every such provider is listed, but the variable is named
	// once, since repeating it reads like a mistake.
	const keys: string[] = []
	const seenKeys = new Set<string>()
	const commands: string[] = []
	// Subscriptions first: one variable can serve several providers (OPENCODE_API_KEY
	// covers both OpenCode Zen and Go), and the subscription is the better thing to
	// recommend. Providers whose variables are all already claimed are skipped.
	const detected = [...halProvider.detectedProviders()].sort((a, b) => Number(auth.isSubscription(b[0])) - Number(auth.isSubscription(a[0])))
	for (const [provider, present] of detected) {
		const fresh = present.filter((name) => !seenKeys.has(name))
		if (fresh.length === 0) continue
		for (const name of fresh) seenKeys.add(name)
		keys.push(...fresh)
		let model = halProvider.suggestions[provider]
		if (provider === 'grok') model = `grok/${models.resolveModel('grok').split('/').at(-1)}`
		if (model) commands.push(`- \`/model ${model}\` — ${provider}`)
		else commands.push(`- ${provider}: \`/model ${provider}/<model-id>\` for any model that endpoint serves.`)
	}
	// Subscriptions lead: most people arriving from another harness have one.
	const login = 'If you would like to use your Claude or ChatGPT subscription, type \`/login claude\` or \`/login chatgpt\`.'
	if (keys.length) {
		const names = new Intl.ListFormat('en', { type: 'conjunction' }).format(keys)
		return `${login}\n\nI also see ${names} in your environment. To use a key instead, try e.g.:\n\n${commands.join('\n')}`
	}
	return `${login}\n\nOr launch Hal with an API key, such as ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.`
}

// Recorded verbatim from the GPT 5.6 Terra stream that made the active-tabs table
// flicker. U+001F is a safe chunk delimiter: it is not valid ordinary model text.
// Replaying real token boundaries is essential—the renderer's layout changes depend
// on a pipe, Markdown marker, or word fragment arriving independently.
const tableChunks = "##\u001f Recently\u001f active\u001f open\u001f tabs\u001f\n\n\u001f|\u001f Session\u001f |\u001f Last\u001f activity\u001f*\u001f |\u001f Topic\u001f /\u001f last\u001f prompt\u001f |\n\u001f|\u001f---\u001f|\u001f---\u001f:\u001f|\u001f---\u001f|\n\u001f|\u001f **\u001f133\u001f-p\u001fod\u001f**\u001f *(\u001fcurrent\u001f;\u001f working\u001f)*\u001f |\u001f \u001f20\u001f:\u001f54\u001f |\u001f “\u001fShow\u001f recently\u001f active\u001f tabs\u001f”\u001f |\n\u001f|\u001f **\u001f133\u001f-\u001fzen\u001f**\u001f |\u001f \u001f19\u001f:\u001f29\u001f |\u001f Private\u001f Hal\u001f marketing\u001f /\u001f launch\u001f plan\u001f |\n\u001f|\u001f **\u001f133\u001f-h\u001fuh\u001f**\u001f |\u001f \u001f19\u001f:\u001f25\u001f |\u001f “\u001faut\u001fost\u001fash\u001f autore\u001fbase\u001f”\u001f |\n\u001f|\u001f **\u001f133\u001f-\u001ffoo\u001f**\u001f |\u001f \u001f19\u001f:\u001f10\u001f |\u001f “\u001fwith\u001f mc\u001fporter\u001f”\u001f |\n\u001f|\u001f **\u001f133\u001f-web\u001f**\u001f |\u001f \u001f19\u001f:\u001f09\u001f |\u001f No\u001f user\u001f prompt\u001f recorded\u001f |\n\u001f|\u001f **\u001f119\u001f-m\u001fac\u001f**\u001f |\u001f \u001f15\u001f:\u001f52\u001f |\u001f Web\u001f mobile\u001f improvements\u001f plan\u001f |\n\u001f|\u001f **\u001f119\u001f-\u001fgnu\u001f**\u001f |\u001f \u001f15\u001f:\u001f41\u001f |\u001f Build\u001f synthetic\u001f intro\u001f provider\u001f |\n\u001f|\u001f **\u001f115\u001f-\u001faug\u001f**\u001f |\u001f \u001f13\u001f:\u001f18\u001f |\u001f Su\u001funn\u001fit\u001ftele\u001f per\u001fint\u001fä\u001fkir\u001fje\u001fiden\u001f maks\u001fut\u001f ja\u001f tark\u001fist\u001fukset\u001f |\n\n\u001f\\\u001f*\u001fTimes\u001f are\u001f local\u001f (\u001fE\u001fEST\u001f),\u001f based\u001f on\u001f the\u001f latest\u001f history\u001f activity\u001f.\u001f There\u001f are\u001f **\u001f26\u001f open\u001f tabs\u001f**\u001f in\u001f total\u001f;\u001f the\u001f first\u001f five\u001f above\u001f are\u001f today\u001f’s\u001f most\u001f recent\u001f.".split('\x1f')
// Deliberately not a general XML parser. Unrecognized markup is intro text.
const CONTROL_RE = /<pause for="(\d+(?:\.\d+)?)s"\s*\/>|<pause until="enter"\s*\/>|<config key="([^"]+)" value="([^"]*)"\s*\/>/g

// An explicit halProvider.script overrides the per-model script, which keeps
// scripted scenarios reproducible from tests and eval.
function scriptFor(): string {
	return halProvider.script || halProvider.introScript()
}

function pages(source = scriptFor()): ScriptPage[] {
	const result: ScriptPage[] = []
	let steps: ScriptStep[] = []
	let offset = 0
	function addText(text: string): void {
		if (text) steps.push({ type: 'text', text })
	}
	function finish(pause: boolean): void {
		let text = ''
		for (const step of steps) {
			if (step.type === 'text') text += step.text
		}
		result.push({ steps, text, pause })
		steps = []
	}
	for (const match of source.matchAll(CONTROL_RE)) {
		addText(source.slice(offset, match.index))
		offset = match.index + match[0].length
		if (match[1]) steps.push({ type: 'delay', ms: Number(match[1]) * 1000 })
		else if (match[2]) steps.push({ type: 'config', key: match[2], value: match[3] ?? '' })
		else finish(true)
	}
	addText(source.slice(offset))
	if (steps.length > 0 || result.length === 0) finish(false)
	return result
}

function messageText(message: Message): string {
	if (typeof message.content === 'string') return message.content
	let text = ''
	for (const block of message.content as ContentBlock[]) {
		if (block.type === 'text') text += block.text ?? ''
	}
	return text
}

// Streamed pages are matched by consuming them from the front of the assistant
// text: consecutive intro pages have no user turn between them, so api-messages
// concatenates several pages into a single assistant message.
function nextPage(messages: Message[], available: ScriptPage[]): number {
	let page = 0
	for (const message of messages) {
		if (message.role !== 'assistant') continue
		let text = messageText(message)
		while (page < available.length && text.startsWith(available[page]!.text)) {
			text = text.slice(available[page]!.text.length)
			page++
		}
	}
	return page
}

function wordChunks(text: string): string[] {
	const leading = text.match(/^\s*/)?.[0] ?? ''
	const words = text.slice(leading.length).match(/\S+\s*/g) ?? []
	if (words.length === 0) return text ? [text] : []
	words[0] = leading + words[0]
	return words
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return
	await new Promise<void>((resolve) => {
		const timer = setTimeout(done, ms)
		function done(): void {
			clearTimeout(timer)
			signal?.removeEventListener('abort', done)
			resolve()
		}
		signal?.addEventListener('abort', done, { once: true })
	})
}

async function* streamText(text: string, req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
	const rate = halProvider.config.wordsPerSecond
	if (!Number.isFinite(rate) || rate <= 0) throw new Error('halProvider.wordsPerSecond must be greater than zero')
	const chunks = wordChunks(text)
	for (let i = 0; i < chunks.length; i++) {
		if (req.signal?.aborted) return
		yield { type: 'text', text: chunks[i] }
		// A skipped intro still streams word by word, just without pacing.
		if (i < chunks.length - 1 && !state.skipped.has(req.sessionId ?? '')) await halProvider.sleep(1000 / rate, req.signal)
	}
}

function tableStreamDelay(): number {
	const rate = halProvider.config.tableChunksPerSecond
	if (!Number.isFinite(rate) || rate <= 0) throw new Error('halProvider.tableChunksPerSecond must be greater than zero')
	return 1000 / rate
}

async function* streamTable(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
	for (const chunk of tableChunks) {
		if (req.signal?.aborted) return
		yield { type: 'text', text: chunk }
		await halProvider.sleep(tableStreamDelay(), req.signal)
	}
}

function toolResultIds(messages: Message[]): Set<string> {
	const ids = new Set<string>()
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue
		for (const block of message.content) {
			if (block.type === 'tool_result' && block.tool_use_id) ids.add(block.tool_use_id)
		}
	}
	return ids
}

function scrollCalls(phase: 'a' | 'b'): ProviderStreamEvent[] {
	const delays = phase === 'a' ? [4, 6, 8, 10, 12] : [12, 1, 2, 3, 4]
	const calls: ProviderStreamEvent[] = []
	for (let index = 0; index < delays.length; index++) {
		const number = index + 1
		let command = `sleep ${delays[index]}; seq -f B${number}-%g 1 20`
		if (phase === 'a' || index === 0) {
			const ticks = delays[index]! * 2
			command = `for i in {1..${ticks}};do echo ${phase.toUpperCase()}${number}-$i;sleep .5;done`
		}
		calls.push({ type: 'tool_call', id: `hal-scroll-${phase}${number}`, name: 'bash', input: { command } })
	}
	return calls
}


async function* scrollRepro(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
	const results = toolResultIds(req.messages)
	if (results.has('hal-scroll-b1')) {
		yield { type: 'text', text: 'SCROLL TEST COMPLETE — inspect both batches for duplicate, missing, or interleaved A/B rows. Every card should be at most 10 physical rows. A short terminal may have snapped to the live bottom, but its final transcript must be canonical.' }
		yield { type: 'done' }
		return
	}
	const phase = results.has('hal-scroll-a1') ? 'b' : 'a'
	if (phase === 'a') {
		yield { type: 'text', text: 'PHASE A — FRONTIER HANDOFF. Five Bash tools start concurrently. Cards should appear in call order at 100ms intervals. A1 streams first while A2–A5 stay as header-only summaries; then A2, A3, A4, and A5 expand in turn as each earlier tool finishes.' }
	} else {
		yield { type: 'text', text: 'PHASE B — SLOW LEADER. B1 streams for about 12 seconds while B2–B5 finish early and remain header-only summaries. In a tall terminal this should remain writable without snapping. In a short terminal, an unsafe B1 update may deliberately snap and rebuild, but must never leave duplicate or interleaved rows.' }
	}
	for (const call of scrollCalls(phase)) yield call
	yield { type: 'done' }
}

async function* generate(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
	if (req.model === 'table' && !halProvider.script) {
		yield* streamTable(req)
		yield { type: 'done' }
		return
	}
	if (req.model === 'scroll' && !halProvider.script) {
		yield* scrollRepro(req)
		return
	}
	const available = pages(scriptFor())
	const first = nextPage(req.messages, available)
	if (first >= available.length) {
		yield { type: 'done' }
		return
	}
	// After Esc, pauses and Enter gates are passed and every remaining page plays
	// through, so one keypress lands at the end of the intro. Skip takes effect at
	// the next word or pause boundary, which is at most half a second away.
	const sessionId = req.sessionId ?? ''
	const skipped = () => state.skipped.has(sessionId)
	for (let index = first; index < available.length; index++) {
		for (const step of available[index]!.steps) {
			if (req.signal?.aborted) return
			if (step.type === 'text') yield* streamText(step.text, req)
			else if (step.type === 'delay' && !skipped()) await halProvider.sleep(step.ms, req.signal)
			else if (step.type === 'config') yield { type: 'config', key: step.key, value: step.value }
		}
		if (req.signal?.aborted) return
		if (available[index]!.pause && !skipped()) {
			yield { type: 'pause' }
			return
		}
	}
	state.skipped.delete(sessionId)
	yield { type: 'done' }
}

const provider: Provider = { generate }

// script stays empty unless a caller pins one scenario for every model.
export const halProvider = { config, state, script: '', introScript, suggestions, priorities, random: Math.random, detectedProviders, introDefaultModel, introModelText, providerSetupText, provider, pages, scriptFor, nextPage, wordChunks, sleep, streamText, tableStreamDelay, streamTable, toolResultIds, scrollCalls, scrollRepro }
