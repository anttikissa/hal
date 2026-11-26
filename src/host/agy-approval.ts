// Answers `agy acp` `session/request_permission` calls: by Hal's own
// security policy (agyPermissions 'hal'), or through Hal's approval
// question UI ('ask'). Task xbp.

import { existsSync } from 'fs'
import { settings } from '../common/settings.ts'
import { forms, type Answers, type Form } from '../common/forms.ts'
import { toolDetails } from '../common/tool-details.ts'
import { approval } from './approval.ts'
import { diag } from './diag.ts'
import { history } from './history.ts'
import { projectContext } from './project-context.ts'
import { sessions } from './sessions.ts'
import { slash } from './slash.ts'

type PermissionOption = { optionId: string; name?: string; kind?: string }
type PermissionResult = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }
type Pending = {
	sessionId: string
	questionId?: string
	options: { label: string; optionId: string }[]
	resolve: (res: PermissionResult) => void
	settled: Promise<void>
}

const state = {
	pending: new Map<string, Pending>(),
	hooked: false,
}

function ensureHook(): void {
	if (state.hooked) return
	state.hooked = true
	slash.state.dismissed.add((sessionId, questionId) => agyApproval.dismiss(sessionId, questionId))
}

function uniqueLabels(options: PermissionOption[]): { label: string; optionId: string }[] {
	let used = new Set<string>()
	return options.map((o) => {
		let base = (o.name?.trim() || o.optionId).replace(/\s+/g, ' ')
		let label = base
		for (let i = 2; used.has(label); i++) label = `${base} (${i})`
		used.add(label)
		return { label, optionId: o.optionId }
	})
}

function buildForm(
	params: Record<string, any>,
	options: PermissionOption[],
	labeled: { label: string; optionId: string }[],
): Form {
	let tool = params?.toolCall ?? {}
	let rawInput =
		tool.rawInput && typeof tool.rawInput === 'object'
			? (tool.rawInput as Record<string, unknown>)
			: tool.args && typeof tool.args === 'object'
				? (tool.args as Record<string, unknown>)
				: {}
	let command = typeof rawInput.CommandLine === 'string' ? rawInput.CommandLine : undefined
	let findings = command ? approval.findings(command) : []
	let head = `Antigravity permission needed: ${tool.title ?? tool.name ?? 'tool call'}`
	let text = [head, ...new Set(findings.map((f) => f.reason))].join('\n')
	let rest = Object.fromEntries(Object.entries(rawInput).filter(([k]) => k !== 'toolSummary'))
	let quoteText = command ?? (Object.keys(rest).length ? toolDetails.value(rest).join('\n') : undefined)
	let rejectIdx = options.findIndex((o) => o.kind?.includes('reject') || /deny|reject|no/i.test(o.name ?? o.optionId))
	return {
		text,
		...(quoteText && {
			quote: { text: quoteText, ...(findings.length && { marks: findings.map((f) => f.at) }) },
		}),
		fields: [
			{
				type: 'choice',
				name: 'run',
				options: labeled.map((l) => l.label),
				initial: rejectIdx >= 0 ? rejectIdx : labeled.length - 1,
			},
		],
	}
}

// agyPermissions 'hal': what Hal itself would ask about. Commands
// matching dangerous patterns go to the user, reads of sensitive paths
// are refused, the rest runs; under security 'yolo' everything runs.
function automatic(params: Record<string, any>): 'allow' | 'reject' | undefined {
	let mode = settings.agyPermissions()
	if (mode === 'ask') return undefined
	if (mode === 'skip' || settings.security() === 'yolo') return 'allow'
	let raw = params?.toolCall?.rawInput ?? {}
	if (typeof raw.CommandLine === 'string') return approval.findings(raw.CommandLine).length ? undefined : 'allow'
	let path =
		typeof raw.Path === 'string' ? raw.Path : typeof raw.AbsolutePath === 'string' ? raw.AbsolutePath : undefined
	return path && approval.sensitive(path) ? 'reject' : 'allow'
}

function request(
	sessionId: string,
	params: Record<string, any>,
	signal?: AbortSignal,
): PermissionResult | Promise<PermissionResult> {
	let cancelled = (): PermissionResult => ({ outcome: { outcome: 'cancelled' } })
	if (!signal || signal.aborted) return cancelled()
	let rawOptions: PermissionOption[] = Array.isArray(params?.options) ? params.options : []
	let reject = rawOptions.find((o) => o.kind?.includes('reject'))
	let select = (o?: PermissionOption): PermissionResult =>
		o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : cancelled()
	if (!rawOptions.length) return cancelled()
	let auto = automatic(params)
	if (auto === 'allow')
		return select(rawOptions.find((o) => o.kind === 'allow_once') ?? rawOptions.find((o) => o.kind?.includes('allow')))
	if (auto === 'reject' || sessions.open(sessionId).interactive === false) return select(reject)
	ensureHook()
	let reqId = crypto.randomUUID().slice(0, 8)
	let labeled = uniqueLabels(rawOptions)
	let form = buildForm(params, rawOptions, labeled)

	return new Promise<PermissionResult>((resolve) => {
		let done = false
		let settled = Promise.withResolvers<void>()
		let pending: Pending = {
			sessionId,
			options: labeled,
			settled: settled.promise,
			resolve(res) {
				if (done) return
				done = true
				state.pending.delete(reqId)
				signal.removeEventListener('abort', onAbort)
				resolve(res)
				// Let agy.ts's .then() write the permission reply before waitPending resumes.
				queueMicrotask(() => settled.resolve())
			},
		}
		let onAbort = () => {
			if (pending.questionId) {
				let current = forms.open(history.readSync(sessionId))
				if (current?.id === pending.questionId) slash.dismiss(sessionId, pending.questionId)
			}
			pending.resolve(cancelled())
		}
		state.pending.set(reqId, pending)
		signal.addEventListener('abort', onAbort, { once: true })
		let reply = slash.report(sessionId, 'approve', `agy:${reqId}`, { ask: form })
		if (reply.error) return pending.resolve(cancelled())
		let open = forms.open(history.readSync(sessionId))
		if (open?.from?.command === 'approve' && open.from.args === `agy:${reqId}`) pending.questionId = open.id
	})
}

async function waitPending(sessionId: string, signal?: AbortSignal): Promise<boolean> {
	let waited = false
	while (!signal?.aborted) {
		let open = [...state.pending.values()].filter((p) => p.sessionId === sessionId)
		if (!open.length) return waited
		waited = true
		await new Promise<void>((resolve) => {
			let done = false
			let finish = () => {
				if (done) return
				done = true
				signal?.removeEventListener('abort', finish)
				resolve()
			}
			if (signal?.aborted) return finish()
			signal?.addEventListener('abort', finish, { once: true })
			void Promise.all(open.map((p) => p.settled)).then(finish)
		})
	}
	return waited
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted || ms <= 0) return Promise.resolve()
	return new Promise((resolve) => {
		let finish = () => {
			clearTimeout(timer)
			signal?.removeEventListener('abort', finish)
			resolve()
		}
		let timer = setTimeout(finish, ms)
		signal?.addEventListener('abort', finish, { once: true })
	})
}

async function withWait<T>(
	sessionId: string,
	signal: AbortSignal,
	isWaitingError: (e: unknown) => boolean,
	run: () => Promise<T>,
): Promise<T | undefined> {
	let attempt = 0
	while (true) {
		await agyApproval.waitPending(sessionId, signal)
		if (signal.aborted) return undefined
		try {
			return await run()
		} catch (e) {
			if (signal.aborted) return undefined
			if (!isWaitingError(e)) throw e
			if (await agyApproval.waitPending(sessionId, signal)) continue
			let delay = agyApproval.retryDelaysMs[attempt++]
			if (delay === undefined) throw e
			await agyApproval.sleep(delay, signal)
		}
	}
}

function handle(
	sessionId: string,
	params: Record<string, any>,
	signal: AbortSignal | undefined,
	reply: (result: PermissionResult) => void,
): void {
	let res = agyApproval.request(sessionId, params, signal)
	if (res instanceof Promise) {
		void res.then(reply).catch((e) => diag.log(`agy permission ${sessionId}: ${e instanceof Error ? e.message : e}`))
	} else {
		reply(res)
	}
}

function answer(reqId: string, answers: Answers): { error?: string } {
	let pending = state.pending.get(reqId)
	if (!pending) return { error: 'That Antigravity permission request is no longer active.' }
	let chosen = String(answers.run ?? '')
	let match = pending.options.find((o) => o.label === chosen)
	pending.resolve(
		match ? { outcome: { outcome: 'selected', optionId: match.optionId } } : { outcome: { outcome: 'cancelled' } },
	)
	return {}
}

function dismiss(sessionId: string, questionId: string): void {
	for (let pending of state.pending.values()) {
		if (pending.sessionId === sessionId && pending.questionId === questionId)
			pending.resolve({ outcome: { outcome: 'cancelled' } })
	}
}

function cancelSession(sessionId: string): void {
	for (let pending of state.pending.values()) {
		if (pending.sessionId === sessionId) pending.resolve({ outcome: { outcome: 'cancelled' } })
	}
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

export const agyApproval = {
	state,
	retryDelaysMs: [25, 50, 100, 150, 200],
	request,
	handle,
	waitPending,
	sleep,
	withWait,
	answer,
	dismiss,
	cancelSession,
	refusal,
}
