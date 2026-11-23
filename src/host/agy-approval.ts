// Answers `agy acp` `session/request_permission` calls: by Hal's own
// security policy (agyPermissions 'hal'), or through Hal's approval
// question UI ('ask'). Task xbp.

import { settings } from '../common/settings.ts'
import { forms, type Answers, type Form } from '../common/forms.ts'
import { toolDetails } from '../common/tool-details.ts'
import { approval } from './approval.ts'
import { history } from './history.ts'
import { sessions } from './sessions.ts'
import { slash } from './slash.ts'

type PermissionOption = { optionId: string; name?: string; kind?: string }
type PermissionResult = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }
type Pending = {
	sessionId: string
	questionId?: string
	options: { label: string; optionId: string }[]
	resolve: (res: PermissionResult) => void
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

function request(sessionId: string, params: Record<string, any>, signal?: AbortSignal): Promise<PermissionResult> {
	let rawOptions: PermissionOption[] = Array.isArray(params?.options) ? params.options : []
	let reject = rawOptions.find((o) => o.kind?.includes('reject'))
	let cancelled = (): PermissionResult => ({ outcome: { outcome: 'cancelled' } })
	let select = (o?: PermissionOption): PermissionResult =>
		o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : cancelled()
	if (!rawOptions.length) return Promise.resolve(cancelled())
	let auto = automatic(params)
	if (auto === 'allow')
		return Promise.resolve(
			select(rawOptions.find((o) => o.kind === 'allow_once') ?? rawOptions.find((o) => o.kind?.includes('allow'))),
		)
	if (auto === 'reject' || sessions.open(sessionId).interactive === false) return Promise.resolve(select(reject))
	if (signal?.aborted) return Promise.resolve(cancelled())
	ensureHook()
	let reqId = crypto.randomUUID().slice(0, 8)
	let labeled = uniqueLabels(rawOptions)
	let form = buildForm(params, rawOptions, labeled)

	return new Promise<PermissionResult>((resolve) => {
		let done = false
		let pending: Pending = {
			sessionId,
			options: labeled,
			resolve(res) {
				if (done) return
				done = true
				state.pending.delete(reqId)
				signal?.removeEventListener('abort', onAbort)
				resolve(res)
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
		signal?.addEventListener('abort', onAbort, { once: true })
		let reply = slash.report(sessionId, 'approve', `agy:${reqId}`, { ask: form })
		if (reply.error) return pending.resolve(cancelled())
		let open = forms.open(history.readSync(sessionId))
		if (open?.from?.command === 'approve' && open.from.args === `agy:${reqId}`) pending.questionId = open.id
	})
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

export const agyApproval = { state, request, answer, dismiss, cancelSession }
