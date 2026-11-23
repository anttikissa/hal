// Runs Google's Antigravity agent (`agy acp`, Agent Client Protocol over
// stdio) as a Hal model, so a Google AI subscription works in Hal through
// Google's own client. agy keeps its conversation and runs its own tools:
// Hal sends only what is new since agy last saw the history, shows agy's
// tool calls as hosted tools (never run by Hal), and seeds a fresh agy
// session with a transcript whenever the history no longer extends what
// agy saw (restart, /compact, /rebase, /edit, fork, another model's
// turn). Task xbp.
import { existsSync } from 'fs'
import type { StreamEvent } from '../common/blocks.ts'
import type { ProviderRequest, SseMessage } from './provider.ts'
import { settings } from '../common/settings.ts'
import { strings } from '../common/strings.ts'
import { sessions } from './sessions.ts'
import { diag } from './diag.ts'
import { jobs } from './jobs.ts'
import { projectContext } from './project-context.ts'
import { agyApproval } from './agy-approval.ts'
import { agyCards } from './agy-cards.ts'
import { agyMcp, type McpBridge, type McpResult } from './agy-mcp.ts'
import { agyModels } from './agy-models.ts'
import { agyPrompt, type AcpContent } from './agy-prompt.ts'

type Update = Record<string, any>
type Agent = {
	sessionId: string
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
	idleTimer?: ReturnType<typeof setTimeout>
	skipPermissions: boolean
	// The agy session and the history prefix it has seen.
	acpSession?: string
	cwd?: string
	prefix: number
	hash?: string
	resumeError?: string
	model?: string
	effort?: string
	thoughtLevels?: string[]
}

// Picks up the agy session saved in agy.ason before a restart; on failure
// explicit prompts seed a new one, while resumeOnly recovery stops.
async function resume(sessionId: string, agent: Agent, cwd: string, system: string): Promise<void> {
	agent.resumeError = undefined
	let data = agyPrompt.loadSaved(sessionId)
	if (!data.acpSession) {
		agent.resumeError = 'no saved agy session'
		return
	}
	if (data.cwd !== cwd) {
		agent.resumeError = `working directory changed (${data.cwd ?? 'unknown'} to ${cwd})`
		return
	}
	try {
		await call(agent, 'session/resume', { sessionId: data.acpSession, cwd, mcpServers: [], ...meta(system) })
		Object.assign(agent, {
			acpSession: data.acpSession,
			cwd,
			prefix: data.prefix ?? 0,
			hash: data.hash,
			resumeError: undefined,
		})
	} catch (e) {
		let detail = e instanceof Error ? e.message : String(e)
		agent.resumeError = `session/resume failed: ${detail}`
		diag.log(`agy: resuming ${data.acpSession} failed, seeding a new session: ${detail}`)
	}
}

const state = {
	agents: new Map<string, Agent>(),
}

function recordConfigOptions(agent: Agent, options: any[] | undefined): void {
	if (!Array.isArray(options)) return
	let thought = options.find((o) => o?.id === 'thought_level')
	if (thought) {
		if (typeof thought.currentValue === 'string') agent.effort = thought.currentValue
		if (Array.isArray(thought.options))
			agent.thoughtLevels = thought.options
				.map((o: any) => o?.value)
				.filter((v: unknown): v is string => typeof v === 'string')
	}
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

function spawn(sessionId: string, cwd: string, skipPermissions: boolean): Agent {
	let mcp: McpBridge | undefined
	let agent: Agent
	let mcpResults = new Map<string, McpResult[]>()
	let args = [...agy.command(), 'acp', '--disable-telemetry']
	if (skipPermissions) args.push('--dangerously-skip-permissions')
	if (Bun.which('nc') && agyMcp.list(sessionId).length) {
		mcp = agyMcp.start(
			sessionId,
			() => agent?.turnSignal,
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
	agent = {
		sessionId,
		proc,
		next: 0,
		calls: new Map(),
		tools: new Map(),
		mcpResults,
		stderr: '',
		stderrDone,
		mcp,
		skipPermissions,
		prefix: 0,
	}
	void readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => receive(agent, line))
	agent.stderrDone = readLines(proc.stderr as ReadableStream<Uint8Array>, (line) => appendStderr(agent, line))
	void proc.exited.then(async (code) => {
		if (agent.idleTimer) clearTimeout(agent.idleTimer)
		agyApproval.cancelSession(sessionId)
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

function scheduleIdle(sessionId: string, agent: Agent): void {
	if (agent.idleTimer) clearTimeout(agent.idleTimer)
	if (agent.exited || agent.turnSignal || agy.idleTimeoutMs <= 0) return
	agent.idleTimer = setTimeout(() => {
		if (state.agents.get(sessionId) === agent && !agent.turnSignal) agy.stop(sessionId)
	}, agy.idleTimeoutMs)
	agent.idleTimer.unref?.()
}

function stop(sessionId: string): void {
	let agent = state.agents.get(sessionId)
	if (!agent) return
	state.agents.delete(sessionId)
	if (agent.idleTimer) clearTimeout(agent.idleTimer)
	agent.idleTimer = undefined
	agyApproval.cancelSession(sessionId)
	agent.mcp?.stop()
	try {
		agent.proc.kill()
	} catch {}
}

function stopAll(): void {
	for (let id of state.agents.keys()) agy.stop(id)
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
	if (msg.method === 'session/update') {
		if (msg.params?.sessionId === agent.acpSession) agent.onUpdate?.(msg.params.update)
		return
	}
	if (msg.method === 'session/request_permission' && msg.id !== undefined) {
		void agyApproval
			.request(agent.sessionId, msg.params, agent.turnSignal)
			.then((result) => {
				if (!agent.exited) write(agent, { id: msg.id, result })
			})
			.catch((e) => diag.log(`agy permission ${agent.sessionId}: ${e instanceof Error ? e.message : e}`))
		return
	}
	if (msg.method && msg.id !== undefined) {
		write(agent, { id: msg.id, error: { code: -32601, message: `Hal does not support ${msg.method}` } })
		return
	}
	let pending = agent.calls.get(msg.id)
	if (!pending) return
	agent.calls.delete(msg.id)
	if (msg.error) pending.reject(rpcError(msg.error, agent.stderr))
	else pending.resolve(msg.result)
}

// Hal's system prompt rides on session/new and session/resume.
function meta(system: string): object {
	return system ? { _meta: { antigravity: { systemPrompt: { append: system } } } } : {}
}

async function agentFor(sessionId: string, cwd: string, system: string): Promise<Agent> {
	let skipPermissions = settings.agyPermissions() === 'skip'
	let agent = state.agents.get(sessionId)
	if (agent && !agent.exited && (agent.skipPermissions === skipPermissions || agent.turnSignal)) return agent
	if (agent) agy.stop(sessionId)
	agent = spawn(sessionId, cwd, skipPermissions)
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
	await resume(sessionId, agent, cwd, system)
	return agent
}

// agy's own shell and file tools ignore Hal's tool list, and agy reads
// <cwd>/AGENTS.md and GEMINI.md itself: refuse what Hal cannot enforce.
function refusal(sessionId: string, cwd: string): string | undefined {
	let session = sessions.open(sessionId)
	if (session.tools && !session.tools.includes('bash'))
		return `agy runs its own shell and file tools, which Hal cannot restrict, and this session may not run commands (tools: ${session.tools.join(', ') || 'none'}). Use another model for it.`
	if (projectContext.allowed(cwd, session.projectTrust)) return undefined
	let file = ['AGENTS.md', 'GEMINI.md'].map((name) => `${cwd}/${name}`).find((path) => existsSync(path))
	if (file)
		return `agy reads ${file} on its own, and this project is not trusted. Trust it with /trust, or use another model here.`
	return undefined
}

async function prompt(req: ProviderRequest, emit: (e: StreamEvent) => void, signal: AbortSignal): Promise<void> {
	let sessionId = req.sessionId
	if (!sessionId) throw new Error('agy needs a Hal session')
	let session = sessions.open(sessionId)
	let cwd = session.cwd
	let refused = refusal(sessionId, cwd)
	if (refused) throw new Error(refused)
	let started = { model: session.model, effort: session.effort }
	let system = agyPrompt.system(req, cwd)
	let agent = await agentFor(sessionId, cwd, system)
	if (agent.idleTimer) {
		clearTimeout(agent.idleTimer)
		agent.idleTimer = undefined
	}
	try {
		await turn(agent, req, emit, signal, cwd, started, system)
	} finally {
		scheduleIdle(sessionId, agent)
	}
}

async function turn(
	agent: Agent,
	req: ProviderRequest,
	emit: (e: StreamEvent) => void,
	signal: AbortSignal,
	cwd: string,
	started: { model: string; effort?: string },
	system: string,
): Promise<void> {
	let sessionId = agent.sessionId
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
	let fresh = agyPrompt.unseen(agent, req.messages, cwd)
	let content: AcpContent[]
	if (fresh) {
		content = agyPrompt.toContent(fresh, req, false)
		if (!content.length) content = [{ type: 'text', text: 'Continue where you left off.' }]
	} else if (req.resumeOnly) {
		let why = agent.resumeError ?? 'session history diverged from saved agy prefix'
		throw new Error(
			`Host restarted after /restart, but agy could not resume its previous session (${why}); not starting a fresh session automatically because it may repeat completed work.`,
		)
	} else {
		let created = await call(agent, 'session/new', { cwd, mcpServers: [], ...meta(system) })
		agent.acpSession = created.sessionId
		agent.cwd = cwd
		agent.model = created.models?.currentModelId
		agent.tools.clear()
		agyModels.record(created.models?.availableModels ?? [])
		recordConfigOptions(agent, created.configOptions)
		content = agyPrompt.seed(req)
	}
	let { modelId: wanted, level } = agyModels.resolve(req.model, req.effort)
	if (agent.model !== wanted) {
		await call(agent, 'session/set_model', { sessionId: agent.acpSession, modelId: wanted })
		agent.model = wanted
		if (level && wanted.endsWith(`-${level}`)) agent.effort = level
	}
	if (level && !wanted.endsWith(`-${level}`) && agent.thoughtLevels?.includes(level) && agent.effort !== level) {
		let updated = await call(agent, 'session/set_config_option', {
			sessionId: agent.acpSession,
			configId: 'thought_level',
			value: level,
		})
		recordConfigOptions(agent, updated?.configOptions)
		agent.effort = level
	}
	if (signal.aborted) return
	let lastUsed: number | undefined
	let onUpdate = (u: Update) => {
		let kind = u.sessionUpdate
		if (kind === 'config_option_update') return recordConfigOptions(agent, u.configOptions)
		if (kind === 'usage_update') {
			if (typeof u.size === 'number' && u.size > 0) agyModels.state.windows.set(req.model, u.size)
			if (typeof u.used === 'number' && u.used > 0) lastUsed = u.used
			return
		}
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
		// A steer adds a prompt to the running agy turn; /model and /cd
		// abort the same way but must stop it.
		let now = sessions.open(sessionId)
		let changed = now.cwd !== cwd || now.model !== started.model || now.effort !== started.effort
		if ((signal.reason !== jobs.steered || changed) && agent.acpSession) {
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
		agent.hash = agyPrompt.hash(req.messages)
		agyPrompt.saveState(sessionId, agent)
		let result = await Promise.race([reply, settled.promise])
		if (signal.aborted) {
			void reply.catch(() => {})
			return
		}
		let u = result?.usage
		let usage: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number } = {}
		if (u) {
			if (typeof u.inputTokens === 'number' && u.inputTokens > 0) usage.input = u.inputTokens
			if (typeof u.cachedReadTokens === 'number' && u.cachedReadTokens > 0) usage.cacheRead = u.cachedReadTokens
			if (typeof u.cachedWriteTokens === 'number' && u.cachedWriteTokens > 0) usage.cacheWrite = u.cachedWriteTokens
			if (typeof u.outputTokens === 'number' && u.outputTokens > 0) usage.output = u.outputTokens
		}
		if (Object.keys(usage).length || lastUsed !== undefined)
			emit({ type: 'usage', usage, ...(lastUsed !== undefined && { context: lastUsed }) })
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

export const agy = {
	state,
	// Stop an idle agy acp process after 15 minutes; the next prompt resumes via agy.ason.
	idleTimeoutMs: 15 * 60_000,
	command: (): string[] => ['agy'],
	models: (signal?: AbortSignal) => agyModels.fetch(agy.command(), signal),
	stop,
	stopAll,
	open,
	parse,
}
