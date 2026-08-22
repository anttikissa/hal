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

// Single-token lines fill the viewport quickly at the default streaming rate.
function fillerBlock(count: number): string {
	const lines: string[] = []
	for (let i = 1; i <= count; i++) lines.push(`Line-${String(i).padStart(2, '0')}`)
	return lines.join('\n')
}

const scripts: Record<string, string> = {
	intro: `Hello. This is HAL 9001, a friendly agent harness.<pause for="1s"/>

Press enter to continue.<pause until="enter"/><config key="renderStatus.tabsOpacity" value="1"/>Those are your session tabs. Each one is an independent conversation.<pause for="1s"/>

Press enter to continue.<pause until="enter"/><config key="renderStatus.statusOpacity" value="1"/><config key="renderStatus.helpOpacity" value="1"/>Below them are the status and help bars: session, directory, model, context, and the keys you can press right now.<pause for="1s"/>

Press enter to continue.<pause until="enter"/><config key="renderStatus.promptOpacity" value="1"/><config key="models.default" value="gpt"/>That is your prompt.<pause for="0.5s"/> Choose a real model with \`/model\`, then tell HAL what you would like to do.`,

	// Reproduces the streamed-Markdown scroll corruption fixed in d97b2dc: fill the
	// viewport so the frame is fullscreen, then deliver a code fence one backtick at
	// a time. Each pause forces its own stream delta, which is what made the partial
	// fence briefly render as text and shift rows that were already in scrollback.
	scroll: `Streaming scroll-duplication check. Raise halProvider.wordsPerSecond to run it faster.<pause for="0.5s"/>

${fillerBlock(60)}

That makes **peer** particularly appropriate. A peer is not merely a local client—it is an equal participant in the local process group and may be promoted.

The version-mismatch suffix remains natural:

\`<pause for="0.25s"/>\`<pause for="0.25s"/>\`
host
peer
client
\`<pause for="0.25s"/>\`<pause for="0.25s"/>\`

Scroll up: every Line-NN and every sentence above must appear exactly once.`,
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

async function* generate(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
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
export const halProvider = { config, script: '', scripts, provider, pages, scriptFor, nextPage, wordChunks, sleep, streamText }
