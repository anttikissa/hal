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
	wordsPerSecond: 4,
}

const scripts: Record<string, string> = {
	intro: `Hello. This is HAL 9001, a friendly agent harness.<pause for="1s"/>

Press enter to continue.<pause until="enter"/><config key="renderStatus.tabsOpacity" value="1"/>Those are your session tabs. Each one is an independent conversation.<pause for="1s"/>

Press enter to continue.<pause until="enter"/><config key="renderStatus.statusOpacity" value="1"/><config key="renderStatus.helpOpacity" value="1"/>Below them are the status and help bars: session, directory, model, context, and the keys you can press right now.<pause for="1s"/>

Press enter to continue.<pause until="enter"/><config key="renderStatus.promptOpacity" value="1"/><config key="models.default" value="gpt"/>That is your prompt.<pause for="0.5s"/> Choose a real model with \`/model\`, then tell HAL what you would like to do.`,

	table: `This is the streaming table reproduction. Its incomplete rows deliberately switch between partial cells and complete Markdown rows while every word arrives separately.

| Session | Last activity | Topic / last prompt |
| --- | --- | --- |
| 133-pod (current; working) | 20:54 | Show recently active open tabs, then keep the prompt stable while the stream continues. |
| 133-zen | 19:29 | Private Hal marketing and launch plan with a description long enough to wrap across several table rows. |
| 133-huh | 19:25 | Autostash autorebase investigation, including the exact recovery path and the final status. |
| 133-foo | 19:10 | Add Model Context Protocol support without destabilizing the terminal transcript. |

The table reproduction is complete.`,
}

// Deliberately not a general XML parser. Unrecognized markup is intro text.
const CONTROL_RE = /<pause for="(\d+(?:\.\d+)?)s"\s*\/>|<pause until="enter"\s*\/>|<config key="([^"]+)" value="([^"]*)"\s*\/>/g

// An explicit halProvider.script overrides the per-model script, which keeps
// scripted scenarios reproducible from tests and eval.
function scriptFor(model: string): string {
	return halProvider.script || halProvider.scripts[model] || halProvider.scripts.intro!
}

function pages(source = scriptFor('intro')): ScriptPage[] {
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

function nextPage(messages: Message[], available: ScriptPage[]): number {
	let page = 0
	for (const message of messages) {
		if (message.role !== 'assistant' || page >= available.length) continue
		if (messageText(message) === available[page]!.text) page++
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
		if (i < chunks.length - 1) await halProvider.sleep(1000 / rate, req.signal)
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
	if (req.model === 'scroll' && !halProvider.script) {
		yield* scrollRepro(req)
		return
	}
	const available = pages(scriptFor(req.model))
	const page = available[nextPage(req.messages, available)]
	if (!page) {
		yield { type: 'done' }
		return
	}
	for (const step of page.steps) {
		if (req.signal?.aborted) return
		if (step.type === 'text') yield* streamText(step.text, req)
		else if (step.type === 'delay') await halProvider.sleep(step.ms, req.signal)
		else yield { type: 'config', key: step.key, value: step.value }
	}
	if (req.signal?.aborted) return
	yield { type: page.pause ? 'pause' : 'done' }
}

const provider: Provider = { generate }

// script stays empty unless a caller pins one scenario for every model.
export const halProvider = { config, script: '', scripts, provider, pages, scriptFor, nextPage, wordChunks, sleep, streamText, toolResultIds, scrollCalls, scrollRepro }
