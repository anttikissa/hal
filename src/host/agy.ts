// Runs Google's Antigravity agent (`agy acp`, Agent Client Protocol over
// stdio) as a Hal model, so a Google AI subscription works in Hal through
// Google's own client. agy keeps its conversation and runs its own tools:
// Hal sends only what is new since agy last saw the history, shows agy's
// tool calls as hosted tools (never run by Hal), and seeds a fresh agy
// session with a transcript whenever the history no longer extends what
// agy saw (restart, /compact, /rebase, /edit, fork, another model's
// turn). Task xbp.
import { blocks, type ImageBlock, type Message, type StreamEvent } from '../common/blocks.ts'
import { provider, type ProviderRequest, type SseMessage } from './provider.ts'
import type { Capability } from './model-effort.ts'
import type { EffortLevel } from '../common/effort-levels.ts'
import { strings } from '../common/strings.ts'
import { sessions } from './sessions.ts'
import { paths } from './paths.ts'
import { liveFiles } from './live-file.ts'
import { diag } from './diag.ts'
import { jobs } from './jobs.ts'
import { agyCards } from './agy-cards.ts'
import { agyMcp, type McpBridge, type McpResult } from './agy-mcp.ts'

type Update = Record<string, any>
type Agent = {
	proc: ReturnType<typeof Bun.spawn>
	next: number
	calls: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>
	tools: Map<string, Update>
	mcpResults: Map<string, McpResult[]>
	onUpdate?: (u: Update) => void
	stderr: string
	stderrDone: Promise<void>
	exited?: string
	mcp?: McpBridge
	turnSignal?: AbortSignal
	canceling?: Promise<void>
	// The agy session and the history prefix it has seen.
	acpSession?: string
	cwd?: string
	prefix: number
	hash?: string
	model?: string
}

// What survives a host restart: the agy session and the history prefix
// it has seen, in the Hal session's directory (a fork does not copy it).
type Saved = { acpSession?: string; cwd?: string; prefix?: number; hash?: string }

function saved(sessionId: string): Saved {
	return liveFiles.liveFile<Saved>(`${paths.sessionDir(sessionId)}/agy.ason`, {}, { watch: false })
}

function save(sessionId: string, agent: Agent): void {
	let data = saved(sessionId)
	Object.assign(data, { acpSession: agent.acpSession, cwd: agent.cwd, prefix: agent.prefix, hash: agent.hash })
	liveFiles.save(data)
	liveFiles.close(data)
}

// Picks up the agy session saved before a restart; on failure the next
// prompt seeds a new one with a transcript.
async function resume(sessionId: string, agent: Agent, cwd: string): Promise<void> {
	let data = saved(sessionId)
	let { acpSession, prefix, hash } = data
	let same = data.cwd === cwd
	liveFiles.close(data)
	if (!acpSession || !same) return
	try {
		await call(agent, 'session/resume', { sessionId: acpSession, cwd, mcpServers: [] })
		Object.assign(agent, { acpSession, cwd, prefix: prefix ?? 0, hash })
	} catch (e) {
		diag.log(`agy: resuming ${acpSession} failed, seeding a new session: ${e instanceof Error ? e.message : e}`)
	}
}

const state = {
	agents: new Map<string, Agent>(),
	// Model ids agy offered last (with effort suffixes), for the picker.
	offered: [] as string[],
}

const known = () => [
	'gemini-4-neon',
	'gemini-4-argon',
	'gemini-4-hydrogen',
	'gemini-3.8-flash',
	'claude-opus-5-5',
	'claude-sonnet-5-5',
	'gpt-oss-120b',
]

function models(): string[] {
	let bases = state.offered.map((id) => id.replace(/-(low|medium|high|xhigh)$/, ''))
	return bases.length ? [...new Set(bases)] : known()
}

function capability(model: string): Capability {
	let levels: EffortLevel[] = /neon|hydrogen/.test(model)
		? ['low', 'medium', 'high', 'xhigh']
		: model.startsWith('gpt-oss')
			? ['medium']
			: ['low', 'medium', 'high']
	return { levels, default: levels.includes('high') ? 'high' : levels[0]!, wire: () => ({}) }
}

const stderrLimit = 64_000
const authHint =
	/\b(unauthenticated|not logged in|login required|sign[- ]?in|auth(?:entication)? (?:required|failed|expired)|token expired|credentials? (?:expired|invalid|missing)|oauth)\b/i

function appendStderr(agent: Agent, line: string): void {
	let next = `${agent.stderr}${line}\n`
	agent.stderr = next.length > stderrLimit ? strings.sliceText(next, -stderrLimit) : next
}

function formatError(head: string, detail?: string, stderr?: string): string {
	let parts = [head]
	if (detail && !head.includes(detail)) parts.push(detail)
	let errText = stderr?.trim()
	if (errText && !parts.some((p) => p.includes(errText))) parts.push(`stderr:\n${errText}`)
	let full = parts.join('\n')
	if (authHint.test(full)) full += '\nSign in again by running `agy acp --login` in a terminal.'
	return full
}

function rpcError(err: any, stderr?: string): Error {
	let code = err?.code !== undefined ? ` (${err.code})` : ''
	let msg = typeof err?.message === 'string' && err.message ? err.message : 'ACP error'
	let data =
		err?.data === undefined ? undefined : typeof err.data === 'string' ? err.data : JSON.stringify(err.data, null, 2)
	return new Error(formatError(`agy${code}: ${msg}`, data, stderr))
}

function spawn(sessionId: string, cwd: string): Agent {
	let mcp: McpBridge | undefined
	let agent: Agent
	let mcpResults = new Map<string, McpResult[]>()
	let args = [...agy.command(), 'acp', '--disable-telemetry', '--dangerously-skip-permissions']
	if (Bun.which('nc') && agyMcp.list(sessionId).length) {
		mcp = agyMcp.start(
			sessionId,
			() => agent?.turnSignal ?? new AbortController().signal,
			(res) => {
				let queue = mcpResults.get(res.name)
				if (queue) queue.push(res)
				else mcpResults.set(res.name, [res])
			},
		)
		args.push('--ide-mcp-port', String(mcp.port))
	}
	let proc: ReturnType<typeof Bun.spawn>
	try {
		proc = Bun.spawn(args, {
			cwd,
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
		})
	} catch (e) {
		mcp?.stop()
		let detail = e instanceof Error ? e.message : String(e)
		throw new Error(`agy failed to start (${args.join(' ')} in ${cwd}): ${detail}`)
	}
	let stderrDone = Promise.resolve()
	agent = { proc, next: 0, calls: new Map(), tools: new Map(), mcpResults, stderr: '', stderrDone, mcp, prefix: 0 }
	void readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => receive(agent, line))
	agent.stderrDone = readLines(proc.stderr as ReadableStream<Uint8Array>, (line) => appendStderr(agent, line))
	void proc.exited.then(async (code) => {
		await agent.stderrDone.catch(() => {})
		agent.mcp?.stop()
		let why = code === null ? `signal ${proc.signalCode ?? 'unknown'}` : `code ${code}`
		agent.exited = formatError(`agy acp exited with ${why}`, undefined, agent.stderr)
		for (let pending of agent.calls.values()) pending.reject(new Error(agent.exited))
		agent.calls.clear()
		if (state.agents.get(sessionId) === agent) state.agents.delete(sessionId)
	})
	return agent
}

async function readLines(stream: ReadableStream<Uint8Array>, each: (line: string) => void): Promise<void> {
	let decoder = new TextDecoder()
	let buf = ''
	for await (let chunk of stream) {
		buf += decoder.decode(chunk, { stream: true })
		let lines = buf.split('\n')
		buf = lines.pop()!
		for (let line of lines) if (line.trim()) each(line)
	}
	buf += decoder.decode()
	if (buf.trim()) each(buf)
}

function write(agent: Agent, msg: object): void {
	let stdin = agent.proc.stdin as import('bun').FileSink
	try {
		stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
		stdin.flush()
	} catch (e) {
		throw new Error(
			agent.exited ??
				formatError(`agy stdin write failed: ${e instanceof Error ? e.message : e}`, undefined, agent.stderr),
		)
	}
}

function call(agent: Agent, method: string, params: object): Promise<any> {
	if (agent.exited) return Promise.reject(new Error(agent.exited))
	let id = ++agent.next
	let reply = new Promise((resolve, reject) => agent.calls.set(id, { resolve, reject }))
	try {
		write(agent, { id, method, params })
	} catch (e) {
		agent.calls.delete(id)
		return Promise.reject(e)
	}
	return reply
}

function receive(agent: Agent, line: string): void {
	let msg: any
	try {
		msg = JSON.parse(line)
	} catch {
		appendStderr(agent, line)
		return
	}
	if (msg.method === 'session/update') return agent.onUpdate?.(msg.params.update)
	if (msg.method && msg.id !== undefined) {
		// Permissions are skipped at launch; Hal offers agy no files or terminal.
		write(agent, { id: msg.id, error: { code: -32601, message: `Hal does not support ${msg.method}` } })
		return
	}
	let pending = agent.calls.get(msg.id)
	if (!pending) return
	agent.calls.delete(msg.id)
	if (msg.error) pending.reject(rpcError(msg.error, agent.stderr))
	else pending.resolve(msg.result)
}

async function agentFor(sessionId: string, cwd: string): Promise<Agent> {
	let agent = state.agents.get(sessionId)
	if (agent && !agent.exited) return agent
	agent = spawn(sessionId, cwd)
	state.agents.set(sessionId, agent)
	try {
		await call(agent, 'initialize', {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		})
	} catch (e) {
		if (state.agents.get(sessionId) === agent) state.agents.delete(sessionId)
		agent.mcp?.stop()
		try {
			agent.proc.kill()
		} catch {}
		throw e
	}
	await resume(sessionId, agent, cwd)
	return agent
}

function hash(messages: Message[]) {
	return String(Bun.hash(JSON.stringify(messages.map((m) => ({ role: m.role, blocks: m.blocks })))))
}

// Hal's notes about hosted tools repeat what agy did; agy knows.
const hostedNote = /^<hal-note>Your \S+ (?:ran|failed) on the provider:/

type AcpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

function imagePart(img: ImageBlock, req: ProviderRequest): AcpContent {
	let data = req.image?.(img.blob)
	return data
		? { type: 'image', data: data.data, mimeType: data.mediaType }
		: { type: 'text', text: provider.imageNote('the image file is no longer available') }
}

function toContent(messages: Message[], req: ProviderRequest, note: boolean): AcpContent[] {
	let out: AcpContent[] = []
	let pushText = (text: string) => {
		let last = out.at(-1)
		if (last?.type === 'text') last.text += `\n\n${text}`
		else out.push({ type: 'text', text })
	}
	for (let m of messages) {
		let parts: AcpContent[] = []
		let addText = (text: string) => {
			let last = parts.at(-1)
			if (last?.type === 'text') last.text += `\n${text}`
			else parts.push({ type: 'text', text })
		}
		for (let b of m.blocks) {
			if (b.type === 'text') {
				if (!note && hostedNote.test(b.text)) continue
				addText(b.text)
			} else if (b.type === 'tool_call') addText(`[tool call] ${String(b.input.cmd ?? JSON.stringify(b.input))}`)
			else if (b.type === 'tool_result') {
				addText(`[tool result${b.isError ? ', error' : ''}] ${strings.sliceText(b.output, 0, 4000)}`)
				for (let img of blocks.resultImages(b)) parts.push(imagePart(img, req))
			} else if (b.type === 'image') parts.push(imagePart(b, req))
		}
		if (!parts.length) continue
		if (note) {
			let head = `## ${m.role === 'user' ? 'User' : 'Assistant'}`
			if (parts[0]?.type === 'text') parts[0] = { type: 'text', text: `${head}\n${parts[0].text}` }
			else parts.unshift({ type: 'text', text: head })
		}
		for (let p of parts)
			if (p.type === 'text') pushText(p.text)
			else out.push(p)
	}
	return out
}

// What agy has not seen yet: messages after its prefix, if they are only
// agy's own reply and new user input. Undefined: agy must start over.
function unseen(agent: Agent, messages: Message[], cwd: string): Message[] | undefined {
	if (!agent.acpSession || agent.cwd !== cwd || messages.length < agent.prefix) return undefined
	if (hash(messages.slice(0, agent.prefix)) !== agent.hash) return undefined
	let rest = messages.slice(agent.prefix)
	let i = rest[0]?.role === 'assistant' ? 1 : 0
	return rest.slice(i).every((m) => m.role === 'user') ? rest.slice(i) : undefined
}

async function prompt(req: ProviderRequest, emit: (e: StreamEvent) => void, signal: AbortSignal): Promise<void> {
	let sessionId = req.sessionId
	if (!sessionId) throw new Error('agy needs a Hal session')
	let cwd = sessions.open(sessionId).cwd
	let agent = await agentFor(sessionId, cwd)
	if (agent.canceling) {
		await Promise.race([
			agent.canceling,
			new Promise<void>((resolve) => {
				if (signal.aborted) return resolve()
				signal.addEventListener('abort', () => resolve(), { once: true })
			}),
		])
	}
	if (signal.aborted) return
	let fresh = unseen(agent, req.messages, cwd)
	let content: AcpContent[]
	if (fresh) {
		content = toContent(fresh, req, false)
		if (!content.length) content = [{ type: 'text', text: 'Continue where you left off.' }]
	} else {
		let created = await call(agent, 'session/new', { cwd, mcpServers: [] })
		agent.acpSession = created.sessionId
		agent.cwd = cwd
		agent.model = created.models?.currentModelId
		agent.tools.clear()
		state.offered = (created.models?.availableModels ?? []).map((m: { modelId: string }) => m.modelId)
		let last = req.messages.findLastIndex((m) => m.role === 'assistant')
		let before = toContent(req.messages.slice(0, last + 1), req, true)
		let now = toContent(req.messages.slice(last + 1), req, false)
		content = before.length
			? [
					{
						type: 'text',
						text: "<hal-transcript>\nThe conversation so far in this Hal session, which you continue. Earlier tool calls were Hal's, not yours.",
					},
					...before,
					{ type: 'text', text: '</hal-transcript>' },
					...now,
				]
			: now
	}
	let wanted =
		[`${req.model}-${req.effort}`, `${req.model}-high`, `${req.model}-medium`].find((id) =>
			state.offered.includes(id),
		) ?? req.model
	if (agent.model !== wanted) {
		await call(agent, 'session/set_model', { sessionId: agent.acpSession, modelId: wanted })
		agent.model = wanted
	}
	if (signal.aborted) return
	let onUpdate = (u: Update) => {
		let kind = u.sessionUpdate
		if (kind === 'agent_message_chunk' && u.content?.type === 'text') emit({ type: 'text', text: u.content.text })
		else if (kind === 'agent_thought_chunk' && u.content?.type === 'text')
			emit({ type: 'thinking', text: u.content.text })
		else if (kind === 'tool_call' || kind === 'tool_call_update') {
			let tool = { ...agent.tools.get(u.toolCallId), ...u }
			agent.tools.set(u.toolCallId, tool)
			if (tool.status === 'completed' || tool.status === 'failed') {
				agent.tools.delete(u.toolCallId)
				let rawName = String(tool.name ?? '')
				let mcpName = rawName.startsWith('mcp_ide-tools_') ? rawName.slice('mcp_ide-tools_'.length) : undefined
				let mcpResult = mcpName ? agent.mcpResults.get(mcpName)?.shift() : undefined
				emit(agyCards.hosted(tool, cwd, mcpResult))
			}
		}
	}
	agent.onUpdate = onUpdate
	agent.turnSignal = signal
	let settled = Promise.withResolvers<undefined>()
	let reply: Promise<any> | undefined
	let onAbort = () => {
		if (agent.onUpdate === onUpdate) agent.onUpdate = undefined
		if (signal.reason !== jobs.steered && agent.acpSession) {
			agent.tools.clear()
			write(agent, { method: 'session/cancel', params: { sessionId: agent.acpSession } })
			if (reply) {
				let wait = Promise.race([
					reply.then(
						() => {},
						() => {},
					),
					Bun.sleep(5000),
				]).finally(() => {
					if (agent.canceling === wait) agent.canceling = undefined
				})
				agent.canceling = wait
			}
		}
		settled.resolve(undefined)
	}
	signal.addEventListener('abort', onAbort)
	try {
		reply = call(agent, 'session/prompt', { sessionId: agent.acpSession, prompt: content })
		// agy has the input now, whatever happens to this turn.
		agent.prefix = req.messages.length
		agent.hash = hash(req.messages)
		save(sessionId, agent)
		let result = await Promise.race([reply, settled.promise])
		if (signal.aborted) {
			void reply.catch(() => {})
			return
		}
		let u = result?.usage
		if (u)
			emit({
				type: 'usage',
				usage: { input: u.inputTokens ?? 0, cacheRead: u.cachedReadTokens ?? 0, output: u.outputTokens ?? 0 },
			})
		let reason = result?.stopReason
		emit({ type: 'done', reason: reason === 'max_tokens' ? 'max_tokens' : reason === 'refusal' ? 'refusal' : 'end' })
	} finally {
		signal.removeEventListener('abort', onAbort)
		if (agent.onUpdate === onUpdate) agent.onUpdate = undefined
		if (agent.turnSignal === signal) agent.turnSignal = undefined
	}
}

// The turn as SSE bytes, which provider.stream parses back with parse().
// A comment every 20 s keeps the stream timeout off while agy works.
function open(req: ProviderRequest, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
	let encoder = new TextEncoder()
	let abort = new AbortController()
	let forward = () => {
		if (!abort.signal.aborted) abort.abort(signal?.reason)
	}
	signal?.addEventListener('abort', forward)
	if (signal?.aborted) forward()
	let timer: ReturnType<typeof setInterval>
	return Promise.resolve(
		new ReadableStream<Uint8Array>({
			start(controller) {
				let send = (e: StreamEvent) => {
					if (abort.signal.aborted) return
					try {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
					} catch {}
				}
				timer = setInterval(() => {
					try {
						controller.enqueue(encoder.encode(': working\n\n'))
					} catch {}
				}, 20_000)
				prompt(req, send, abort.signal)
					.catch((e) => send({ type: 'error', message: e instanceof Error ? e.message : String(e) }))
					.finally(() => {
						clearInterval(timer)
						signal?.removeEventListener('abort', forward)
						try {
							controller.close()
						} catch {}
					})
			},
			cancel() {
				clearInterval(timer)
				signal?.removeEventListener('abort', forward)
				if (!abort.signal.aborted) abort.abort(signal?.aborted ? signal.reason : undefined)
			},
		}),
	)
}

async function* parse(messages: AsyncIterable<SseMessage>): AsyncIterable<StreamEvent> {
	for await (let m of messages) yield JSON.parse(m.data) as StreamEvent
}

export const agy = { state, command: (): string[] => ['agy'], known, models, capability, open, parse }
