// Runs Google's Antigravity agent (`agy acp`, Agent Client Protocol over
// stdio) as a Hal model, so a Google AI subscription works in Hal through
// Google's own client. agy keeps its conversation and runs its own tools:
// Hal sends only what is new since agy last saw the history, shows agy's
// tool calls as hosted tools (never run by Hal), and seeds a fresh agy
// session with a transcript whenever the history no longer extends what
// agy saw (restart, /compact, /rebase, /edit, fork, another model's
// turn). Task xbp.
import type { Message, StreamEvent } from '../common/blocks.ts'
import type { ProviderRequest, SseMessage } from './provider.ts'
import type { Capability } from './model-effort.ts'
import type { EffortLevel } from '../common/effort-levels.ts'
import { strings } from '../common/strings.ts'
import { sessions } from './sessions.ts'
import { paths } from './paths.ts'
import { liveFiles } from './live-file.ts'
import { diag } from './diag.ts'
import { agyMcp, type McpBridge } from './agy-mcp.ts'

type Update = Record<string, any>
type Agent = {
	proc: ReturnType<typeof Bun.spawn>
	next: number
	calls: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>
	onUpdate?: (u: Update) => void
	stderr: string
	exited?: string
	mcp?: McpBridge
	turnSignal?: AbortSignal
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

function spawn(sessionId: string, cwd: string): Agent {
	let mcp: McpBridge | undefined
	let agent: Agent
	let args = ['agy', 'acp', '--disable-telemetry', '--dangerously-skip-permissions']
	if (Bun.which('nc') && agyMcp.list(sessionId).length) {
		mcp = agyMcp.start(sessionId, () => agent?.turnSignal ?? new AbortController().signal)
		args.push('--ide-mcp-port', String(mcp.port))
	}
	let proc = Bun.spawn(args, {
		cwd,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	})
	agent = { proc, next: 0, calls: new Map(), stderr: '', mcp, prefix: 0 }
	void readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => receive(agent, line))
	void readLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
		agent.stderr = strings.sliceText(agent.stderr + line + '\n', -4000)
	})
	void proc.exited.then((code) => {
		agent.mcp?.stop()
		agent.exited = `agy acp exited with code ${code}${agent.stderr ? `:\n${agent.stderr}` : ''}`
		for (let call of agent.calls.values()) call.reject(new Error(agent.exited))
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
}

function write(agent: Agent, msg: object): void {
	let stdin = agent.proc.stdin as import('bun').FileSink
	stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
	stdin.flush()
}

function call(agent: Agent, method: string, params: object): Promise<any> {
	if (agent.exited) return Promise.reject(new Error(agent.exited))
	let id = ++agent.next
	let reply = new Promise((resolve, reject) => agent.calls.set(id, { resolve, reject }))
	write(agent, { id, method, params })
	return reply
}

function receive(agent: Agent, line: string): void {
	let msg: any
	try {
		msg = JSON.parse(line)
	} catch {
		agent.stderr = strings.sliceText(agent.stderr + line + '\n', -4000)
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
	if (msg.error) pending.reject(new Error(`agy ${msg.error.message ?? 'error'}: ${JSON.stringify(msg.error)}`))
	else pending.resolve(msg.result)
}

async function agentFor(sessionId: string, cwd: string): Promise<Agent> {
	let agent = state.agents.get(sessionId)
	if (agent && !agent.exited) return agent
	agent = spawn(sessionId, cwd)
	state.agents.set(sessionId, agent)
	await call(agent, 'initialize', {
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
	})
	await resume(sessionId, agent, cwd)
	return agent
}

function hash(messages: Message[]) {
	return String(Bun.hash(JSON.stringify(messages.map((m) => ({ role: m.role, blocks: m.blocks })))))
}

// Hal's notes about hosted tools repeat what agy did; agy knows.
const hostedNote = /^<hal-note>Your \S+ (?:ran|failed) on the provider:/

function render(messages: Message[], note: boolean): string {
	let out: string[] = []
	for (let m of messages) {
		let parts: string[] = []
		for (let b of m.blocks) {
			if (b.type === 'text') {
				if (!note && hostedNote.test(b.text)) continue
				parts.push(b.text)
			} else if (b.type === 'tool_call') parts.push(`[tool call] ${String(b.input.cmd ?? JSON.stringify(b.input))}`)
			else if (b.type === 'tool_result')
				parts.push(`[tool result${b.isError ? ', error' : ''}] ${strings.sliceText(b.output, 0, 4000)}`)
			else if (b.type === 'image') parts.push('[image omitted]')
		}
		if (!parts.length) continue
		out.push(note ? `## ${m.role === 'user' ? 'User' : 'Assistant'}\n${parts.join('\n')}` : parts.join('\n'))
	}
	return out.join('\n\n')
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
	let fresh = unseen(agent, req.messages, cwd)
	let text: string
	if (fresh) {
		text = render(fresh, false) || 'Hal retried after an error. Continue where you left off.'
	} else {
		let created = await call(agent, 'session/new', { cwd, mcpServers: [] })
		agent.acpSession = created.sessionId
		agent.cwd = cwd
		agent.model = created.models?.currentModelId
		state.offered = (created.models?.availableModels ?? []).map((m: { modelId: string }) => m.modelId)
		let last = req.messages.findLastIndex((m) => m.role === 'assistant')
		let before = req.messages.slice(0, last + 1)
		let now = render(req.messages.slice(last + 1), false)
		text = before.length
			? `<hal-transcript>\nThe conversation so far in this Hal session, which you continue. Earlier tool calls were Hal's, not yours.\n\n${render(before, true)}\n</hal-transcript>\n\n${now}`
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
	let tools = new Map<string, Update>()
	agent.onUpdate = (u) => {
		let kind = u.sessionUpdate
		if (kind === 'agent_message_chunk' && u.content?.type === 'text') emit({ type: 'text', text: u.content.text })
		else if (kind === 'agent_thought_chunk' && u.content?.type === 'text')
			emit({ type: 'thinking', text: u.content.text })
		else if (kind === 'tool_call' || kind === 'tool_call_update') {
			let tool = { ...tools.get(u.toolCallId), ...u }
			tools.set(u.toolCallId, tool)
			if (tool.status === 'completed' || tool.status === 'failed') {
				tools.delete(u.toolCallId)
				emit({
					type: 'hosted_tool',
					id: tool.toolCallId,
					name: tool.name ?? tool.kind ?? 'tool',
					input: tool.rawInput ?? tool.args ?? {},
					output: toolOutput(tool),
					...(tool.status === 'failed' && { isError: true }),
				})
			}
		}
	}
	agent.turnSignal = signal
	let onAbort = () => write(agent, { method: 'session/cancel', params: { sessionId: agent.acpSession } })
	signal.addEventListener('abort', onAbort)
	try {
		let reply = call(agent, 'session/prompt', { sessionId: agent.acpSession, prompt: [{ type: 'text', text }] })
		// agy has the input now, whatever happens to this turn.
		agent.prefix = req.messages.length
		agent.hash = hash(req.messages)
		save(sessionId, agent)
		let result = await reply
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
		agent.onUpdate = undefined
		agent.turnSignal = undefined
	}
}

function toolOutput(tool: Update): string {
	let parts: string[] = []
	for (let c of tool.content ?? []) {
		if (c.type === 'diff') parts.push(`--- ${c.path}\n${c.oldText ?? ''}\n+++ ${c.path}\n${c.newText}`)
		else if (c.type === 'content' && c.content?.type === 'text') parts.push(c.content.text)
	}
	if (!parts.length && tool.rawOutput && Object.keys(tool.rawOutput).length) parts.push(JSON.stringify(tool.rawOutput))
	return parts.join('\n') || tool.title || ''
}

// The turn as SSE bytes, which provider.stream parses back with parse().
// A comment every 20 s keeps the stream timeout off while agy works.
function open(req: ProviderRequest): Promise<ReadableStream<Uint8Array>> {
	let encoder = new TextEncoder()
	let abort = new AbortController()
	let timer: ReturnType<typeof setInterval>
	return Promise.resolve(
		new ReadableStream<Uint8Array>({
			start(controller) {
				let send = (e: StreamEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
				timer = setInterval(() => controller.enqueue(encoder.encode(': working\n\n')), 20_000)
				prompt(req, send, abort.signal)
					.catch((e) => send({ type: 'error', message: e instanceof Error ? e.message : String(e) }))
					.finally(() => {
						clearInterval(timer)
						try {
							controller.close()
						} catch {}
					})
			},
			cancel() {
				clearInterval(timer)
				abort.abort()
			},
		}),
	)
}

async function* parse(messages: AsyncIterable<SseMessage>): AsyncIterable<StreamEvent> {
	for await (let m of messages) yield JSON.parse(m.data) as StreamEvent
}

export const agy = { state, known, models, capability, open, parse }
