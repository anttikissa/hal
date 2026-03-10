// Runtime class — holds all session state and provides the API surface for commands and eval.

import { ipc } from '../ipc.ts'
import { appendMessages, readMessages, detectInterruptedTools } from '../session/messages.ts'
import { runAgentLoop } from './agent-loop.ts'
import { context } from './context.ts'
import { systemPrompt } from './system-prompt.ts'
import { tools } from './tools.ts'
import { eventId, type RuntimeEvent, type SessionInfo } from '../protocol.ts'
import { config } from '../config.ts'

const GREETINGS = [
	'Hello! What shall we build today? Say **help** for help.',
	'Hey there! What are we working on? Say **help** for help.',
	'Hi! Ready when you are. Say **help** for help.',
	'Good to see you. What\'s the plan? Say **help** for help.',
]

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]
}

export function timeAgo(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime()
	if (ms < 0) return ''
	const mins = Math.floor(ms / 60_000)
	if (mins < 1) return 'just now'
	if (mins < 60) return `${mins}m ago`
	const hrs = Math.floor(mins / 60)
	if (hrs < 24) return `${hrs}h ago`
	const days = Math.floor(hrs / 24)
	return `${days}d ago`
}

export class Runtime {
	sessions = new Map<string, SessionInfo>()
	activeSessionId: string | null = null
	busySessionIds = new Set<string>()
	abortControllers = new Map<string, AbortController>()
	pendingQuestions = new Map<string, { resolve: (answer: string) => void; question: string }>()
	sessionContext = new Map<string, { used: number; max: number; estimated?: boolean }>()
	pendingInterruptedTools = new Map<string, { name: string; id: string; ref: string }[]>()

	async emit(fields: Omit<RuntimeEvent, 'id' | 'createdAt'>): Promise<void> {
		await ipc.events.append({ ...fields, id: eventId(), createdAt: new Date().toISOString() } as RuntimeEvent)
	}

	async emitInfo(sessionId: string, text: string, level = 'info'): Promise<void> {
		await appendMessages(sessionId, [{ type: 'info', text, level, ts: new Date().toISOString() }])
		await this.emit({ type: 'line', sessionId, text, level })
	}

	estimatedOverheadBytes(info: SessionInfo): number {
		const model = info.model ?? config.getConfig().defaultModel
		const system = systemPrompt.loadSystemPrompt({ model, sessionDir: info.id })
		const cfg = config.getConfig()
		const toolBytes = JSON.stringify(tools.getTools(cfg.eval === true)).length
		return system.bytes + toolBytes
	}

	estimateSessionContext(info: SessionInfo, apiMessages: any[]): { used: number; max: number; estimated: true } {
		const modelId = (info.model ?? config.getConfig().defaultModel).split('/').pop()!
		return context.estimateContext(apiMessages, modelId, this.estimatedOverheadBytes(info))
	}

	setFreshContext(info: SessionInfo): void {
		const ctx = this.estimateSessionContext(info, [])
		this.sessionContext.set(info.id, ctx)
		info.context = ctx
	}

	flushSessionMeta(): void {
		for (const info of this.sessions.values()) {
			;(info as SessionInfo & { save?: () => void }).save?.()
		}
	}

	async publish(activity?: string): Promise<void> {
		const contexts: Record<string, { used: number; max: number; estimated?: boolean }> = {}
		for (const [id, ctx] of this.sessionContext) contexts[id] = ctx
		await this.emit({
			type: 'status', sessionId: null,
			busySessionIds: [...this.busySessionIds], pausedSessionIds: [],
			activeSessionId: this.activeSessionId, busy: this.busySessionIds.size > 0,
			queueLength: 0, activity,
			contexts: Object.keys(contexts).length > 0 ? contexts : undefined,
		})
		await this.emit({
			type: 'sessions',
			activeSessionId: this.activeSessionId, sessions: [...this.sessions.values()],
		})
		this.flushSessionMeta()
		ipc.updateState(s => {
			s.sessions = [...this.sessions.keys()]
			s.activeSessionId = this.activeSessionId
			s.busySessionIds = [...this.busySessionIds]
		})
	}

	hasPendingUserTurn(messages: any[]): boolean {
		if (messages.length === 0) return false
		return messages[messages.length - 1]?.role === 'user'
	}

	async askUser(sessionId: string, question: string): Promise<string> {
		const questionId = eventId()
		return new Promise(resolve => {
			this.pendingQuestions.set(sessionId, { resolve, question })
			void this.emit({ type: 'question', sessionId, questionId, text: question })
		})
	}

	async greetSession(sessionId: string): Promise<void> {
		const text = pick(GREETINGS)
		await appendMessages(sessionId, [{ role: 'assistant', text, ts: new Date().toISOString() }])
	}

	async startGeneration(
		sid: string,
		info: SessionInfo,
		apiMessages: any[],
		activity = 'generating...',
	): Promise<void> {
		const ac = new AbortController()
		this.abortControllers.set(sid, ac)
		this.busySessionIds.add(sid)
		await this.publish(activity)
		const sysPrompt = systemPrompt.loadSystemPrompt({ model: info.model ?? config.getConfig().defaultModel, sessionDir: sid })
		runAgentLoop({
			sessionId: sid,
			model: info.model ?? config.getConfig().defaultModel,
			systemPrompt: sysPrompt.text,
			messages: apiMessages,
			onStatus: async (busy, nextActivity, context) => {
				if (busy) this.busySessionIds.add(sid)
				else this.busySessionIds.delete(sid)
				if (context) {
					this.sessionContext.set(sid, context)
					if (!context.estimated) {
						info.context = { used: context.used, max: context.max }
						const pct = context.used / context.max
						if (pct >= 0.65 && pct < 0.70) {
							await this.emitInfo(sid, `[context] ${Math.round(pct * 100)}% used — will autocompact at 70%`, 'warn')
						}
					}
				}
				await this.publish(nextActivity)
			},
			askUser: (question) => this.askUser(sid, question),
			signal: ac.signal,
		}).finally(async () => {
			this.abortControllers.delete(sid)
			this.busySessionIds.delete(sid)
			await this.publish()
		})
	}

	async resumeInterruptedSession(sessionId: string): Promise<void> {
		const messages = await readMessages(sessionId)
		const interrupted = detectInterruptedTools(messages)
		if (interrupted.length > 0) {
			this.pendingInterruptedTools.set(sessionId, interrupted)
		}
	}

	// Set by startup.ts after wiring up command tail + watchers
	stop: () => void = () => {}
}

// Singleton for eval tool access
let _instance: Runtime | null = null
export function setRuntime(rt: Runtime): void { _instance = rt }
export function getRuntime(): Runtime {
	if (!_instance) throw new Error('Runtime not initialized')
	return _instance
}
