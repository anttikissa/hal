// Runs Google's Antigravity agent (`agy acp`, Agent Client Protocol over
// stdio) as a Hal model, so a Google AI subscription works in Hal through
// Google's own client. agy keeps its conversation and runs its own tools:
// Hal sends only what is new since agy last saw the history, shows agy's
// tool calls as hosted tools (never run by Hal), and seeds a fresh agy
// session with a transcript whenever the history no longer extends what
// agy saw (restart, /compact, /rebase, /edit, fork, another model's
// turn). Task xbp.
import type { StreamEvent } from '../common/blocks.ts'
import type { ProviderRequest, SseMessage } from './provider.ts'
import { settings } from '../common/settings.ts'
import { strings } from '../common/strings.ts'
import { sessions } from './sessions.ts'
import { diag } from './diag.ts'
import { jobs } from './jobs.ts'
import { turns } from './turns.ts'
import { agyApproval } from './agy-approval.ts'
import { agyCards } from './agy-cards.ts'
import { agyLog } from './agy-log.ts'
import { agyMcp, type McpBridge, type McpResult } from './agy-mcp.ts'
import { agyModels } from './agy-models.ts'
import { agyPrompt, type AcpContent } from './agy-prompt.ts'
import { agyAccounts, type AgyAccount } from './agy-accounts.ts'
import { auth } from './auth.ts'
import { clock } from './clock.ts'

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
	turnAbort?: AbortController
	turnGen: number
	canceling?: Promise<void>
	idleTimer?: ReturnType<typeof setTimeout>
	skipPermissions: boolean
	// The account (agy-accounts.ts) agy runs logged in as.
	account: string
	accountRef: AgyAccount
	logPath?: string
	emailChecked?: boolean
	// The agy session and the history prefix it has seen.
	acpSession?: string
	cwd?: string
	prefix: number
	hash?: string
	basePrefix?: number
	baseHash?: string
	model?: string
	effort?: string
	thoughtLevels?: string[]
}

// Picks up the agy session saved in agy.ason before a restart; on failure
// the next prompt seeds a new one with a transcript.
async function resume(sessionId: string, agent: Agent, cwd: string, system: string): Promise<void> {
	let data = agyPrompt.loadSaved(sessionId)
	if (!data.acpSession || data.cwd !== cwd || data.account !== agent.account) return
	try {
		await call(agent, 'session/resume', { sessionId: data.acpSession, cwd, mcpServers: [], ...meta(system) })
		Object.assign(agent, {
			acpSession: data.acpSession,
			cwd,
			prefix: data.prefix ?? 0,
			hash: data.hash,
			basePrefix: data.basePrefix,
			baseHash: data.baseHash,
		})
	} catch (e) {
		diag.log(`agy: resuming ${data.acpSession} failed, seeding a new session: ${e instanceof Error ? e.message : e}`)
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

function appendStderr(agent: Agent, line: string): void {
	let next = `${agent.stderr}${line}\n`
	agent.stderr = next.length > stderrLimit ? strings.sliceText(next, -stderrLimit) : next
}

function spawn(sessionId: string, cwd: string, skipPermissions: boolean, account: AgyAccount): Agent {
	let mcp: McpBridge | undefined
	let agent: Agent
	let mcpResults = new Map<string, McpResult[]>()
	let args = [...agy.command(), 'acp', '--disable-telemetry']
	if (skipPermissions) args.push('--dangerously-skip-permissions')
	if (account.geminiDir) args.push('--gemini-dir', account.geminiDir)
	if (Bun.which('nc') && agyMcp.list(sessionId).length) {
		mcp = agyMcp.start(
			sessionId,
			() => agent?.turnAbort?.signal,
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
			// Makes agy read the account's login from its gemini dir.
			env: account.geminiDir ? { ...process.env, SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 22' } : process.env,
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
		turnGen: 0,
		skipPermissions,
		account: account.name,
		accountRef: account,
		prefix: 0,
	}
	void readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => receive(agent, line))
	agent.stderrDone = readLines(proc.stderr as ReadableStream<Uint8Array>, (line) => appendStderr(agent, line))
	void proc.exited.then(async (code) => {
		if (agent.idleTimer) clearTimeout(agent.idleTimer)
		agent.turnAbort?.abort()
		agent.turnAbort = undefined
		agyApproval.cancelSession(sessionId)
		await agent.stderrDone.catch(() => {})
		agent.mcp?.stop()
		let why = code === null ? `signal ${proc.signalCode ?? 'unknown'}` : `code ${code}`
		agent.exited = agyLog.formatError(`agy acp exited with ${why}`, undefined, agent.stderr)
		for (let pending of agent.calls.values()) pending.reject(new Error(agent.exited))
		agent.calls.clear()
		if (state.agents.get(sessionId) === agent) state.agents.delete(sessionId)
	})
	return agent
}

function scheduleIdle(sessionId: string, agent: Agent): void {
	if (agent.idleTimer) clearTimeout(agent.idleTimer)
	if (agent.exited || agent.turnAbort || agy.idleTimeoutMs <= 0) return
	agent.idleTimer = setTimeout(() => {
		if (state.agents.get(sessionId) === agent && !agent.turnAbort) agy.stop(sessionId)
	}, agy.idleTimeoutMs)
	agent.idleTimer.unref?.()
}

function stop(sessionId: string): void {
	let agent = state.agents.get(sessionId)
	if (!agent) return
	state.agents.delete(sessionId)
	if (agent.idleTimer) clearTimeout(agent.idleTimer)
	agent.idleTimer = undefined
	agent.turnAbort?.abort()
	agent.turnAbort = undefined
	agyApproval.cancelSession(sessionId)
	agent.mcp?.stop()
	try {
		agent.proc.kill()
	} catch {}
}

function stopAll(): void {
	for (let id of state.agents.keys()) agy.stop(id)
	;(require('./login-agy.ts') as typeof import('./login-agy.ts')).loginAgy.cancel()
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
				agyLog.formatError(`agy stdin write failed: ${e instanceof Error ? e.message : e}`, undefined, agent.stderr),
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
			.request(agent.sessionId, msg.params, agent.turnAbort?.signal)
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
	if (msg.error) pending.reject(agyLog.rpcError(msg.error, agent.stderr))
	else pending.resolve(msg.result)
}

// Hal's system prompt rides on session/new and session/resume.
function meta(system: string): object {
	return system ? { _meta: { antigravity: { systemPrompt: { append: system } } } } : {}
}

async function agentFor(sessionId: string, cwd: string, system: string, account: AgyAccount): Promise<Agent> {
	let skipPermissions = settings.agyPermissions() === 'skip'
	let agent = state.agents.get(sessionId)
	if (
		agent &&
		!agent.exited &&
		agent.account === account.name &&
		(agent.skipPermissions === skipPermissions || agent.turnAbort)
	)
		return agent
	if (agent) agy.stop(sessionId)
	agent = spawn(sessionId, cwd, skipPermissions, account)
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

async function prompt(
	req: ProviderRequest,
	emit: (e: StreamEvent) => void,
	signal: AbortSignal,
	accountName?: string,
): Promise<void> {
	let sessionId = req.sessionId
	if (!sessionId) throw new Error('agy needs a Hal session')
	let session = sessions.open(sessionId)
	let cwd = session.cwd
	let refused = agyApproval.refusal(sessionId, cwd)
	if (refused) throw new Error(refused)
	let started = { model: session.model, effort: session.effort }
	let system = agyPrompt.system(req, cwd)
	let accounts = agyAccounts.list()
	let account = accounts.find((a) => a.name === accountName) ?? accounts[0]
	if (!account) throw auth.fail('no agy login; run /login agy')
	let agent = await agentFor(sessionId, cwd, system, account)
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
		content = agyPrompt.promptContent(fresh.messages, req, fresh.edited)
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
	let quota: ReturnType<typeof agyAccounts.quota>
	let pendingWarning: string | undefined
	let emitted = false
	let flushWarning = () => {
		if (!pendingWarning) return
		emit({ type: 'text', text: pendingWarning })
		pendingWarning = undefined
		emitted = true
	}
	let onUpdate = (u: Update) => {
		let kind = u.sessionUpdate
		if (kind === 'config_option_update') return recordConfigOptions(agent, u.configOptions)
		if (kind === 'usage_update') {
			if (typeof u.size === 'number' && u.size > 0) agyModels.state.windows.set(req.model, u.size)
			if (typeof u.used === 'number' && u.used > 0) lastUsed = u.used
			return
		}
		if (kind === 'agent_message_chunk' && u.content?.type === 'text') {
			let text = String(u.content.text)
			let spent = !emitted && !pendingWarning ? agyAccounts.quota(text) : undefined
			if (spent) quota = spent
			else if (!emitted && !pendingWarning && agyLog.warningText(text)) pendingWarning = text
			else {
				flushWarning()
				emitted = true
				emit({ type: 'text', text })
			}
		} else if (kind === 'agent_thought_chunk' && u.content?.type === 'text') {
			flushWarning()
			emitted = true
			emit({ type: 'thinking', text: u.content.text })
		} else if (kind === 'tool_call' || kind === 'tool_call_update') {
			let tool = { ...agent.tools.get(u.toolCallId), ...u }
			agent.tools.set(u.toolCallId, tool)
			if (tool.status === 'completed' || tool.status === 'failed') {
				agent.tools.delete(u.toolCallId)
				flushWarning()
				emitted = true
				let rawName = String(tool.name ?? '')
				let mcpName = rawName.startsWith('mcp_ide-tools_') ? rawName.slice('mcp_ide-tools_'.length) : undefined
				let mcpResult = mcpName ? agent.mcpResults.get(mcpName)?.shift() : undefined
				emit(agyCards.hosted(tool, cwd, mcpResult))
			}
		}
	}
	let cancelTurn = (reason?: unknown) => {
		let abort = agent.turnAbort
		agent.turnAbort = undefined
		abort?.abort(reason)
		if (agent.acpSession && !agent.exited) {
			agent.tools.clear()
			try {
				write(agent, { method: 'session/cancel', params: { sessionId: agent.acpSession } })
			} catch {}
		}
	}
	agent.onUpdate = onUpdate
	let gen = ++agent.turnGen
	let turnAbort = (agent.turnAbort ??= new AbortController())
	let steered = false
	let settled = Promise.withResolvers<undefined>()
	let reply: Promise<any> | undefined
	let onAbort = () => {
		if (agent.onUpdate === onUpdate) agent.onUpdate = undefined
		// A steer injects a prompt into the running agy turn without aborting
		// in-flight MCP tools; /model and /cd cancel the turn like Stop.
		let now = sessions.open(sessionId)
		let changed = now.cwd !== cwd || now.model !== started.model || now.effort !== started.effort
		if (signal.reason === jobs.steered && !changed) {
			steered = true
			let running = turns.state.running.get(sessionId)
			running?.done?.finally(() => {
				if (agent.turnGen !== gen) return
				cancelTurn(running.controller.signal.reason)
				scheduleIdle(sessionId, agent)
			})
		} else {
			cancelTurn(signal.reason)
			if (agent.acpSession && reply) {
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
	agent.logPath ??= agyLog.find(agent.proc.pid, agent.accountRef.geminiDir)
	let logOffset = agyLog.size(agent.logPath)
	try {
		reply = call(agent, 'session/prompt', { sessionId: agent.acpSession, prompt: content })
		// agy has the input now, whatever happens to this turn.
		agyPrompt.recordPrefix(sessionId, agent, req.messages, fresh)
		let result = await Promise.race([reply, settled.promise])
		if (signal.aborted) {
			void reply.catch(() => {})
			return
		}
		agent.logPath ??= agyLog.find(agent.proc.pid, agent.accountRef.geminiDir)
		if (!agent.emailChecked && agent.logPath) {
			agent.emailChecked = true
			let found = agyLog.email(agyLog.readFrom(agent.logPath, 0))
			if (found && agyAccounts.learnEmail(agent.accountRef, found)) {
				agent.account = found
				agyPrompt.saveState(sessionId, agent)
			}
		}
		let usage = agyLog.extractUsage(result?.usage)
		if (Object.keys(usage).length || lastUsed !== undefined)
			emit({ type: 'usage', usage, ...(lastUsed !== undefined && { context: lastUsed }) })
		if (quota) {
			agent.acpSession = undefined
			emit({ type: 'error', message: quota.message, status: 429, retryAt: clock.now() + quota.resetsIn * 1000 })
			return
		}
		if (pendingWarning) {
			let err = agyLog.warningError(pendingWarning, agent.logPath, logOffset, agent.account, sessionId)
			if (err) {
				agent.acpSession = undefined
				emit(err)
				return
			}
			flushWarning()
		}
		agyAccounts.verified(agent.account)
		let reason = result?.stopReason
		emit({ type: 'done', reason: reason === 'max_tokens' ? 'max_tokens' : reason === 'refusal' ? 'refusal' : 'end' })
	} finally {
		signal.removeEventListener('abort', onAbort)
		if (agent.onUpdate === onUpdate) agent.onUpdate = undefined
		if (!steered && agent.turnAbort === turnAbort) {
			agent.turnAbort = undefined
			turnAbort.abort(signal.aborted ? signal.reason : undefined)
		}
	}
}

// The turn as SSE bytes, which provider.stream parses back with parse().
// A comment every 20 s keeps the stream timeout off while agy works.
function open(req: ProviderRequest, signal?: AbortSignal, account?: string): Promise<ReadableStream<Uint8Array>> {
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
				prompt(req, send, abort.signal, account)
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
