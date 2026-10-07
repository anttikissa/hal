// Validation of commands on the host side; protocol.ts holds the types.
// Tasks: 6, qt, svt.
import type { CommandType } from './protocol.ts'
import { rebase } from './rebase.ts'

const commandTypes: CommandType[] = ['queue-edit', 'queue-edit-cancel', 'rebase-error', 'rebase-apply', 'find', 'find-cancel', 'create', 'open-newest', 'open', 'history', 'close', 'submit', 'draft', 'pause', 'continue', 'answer', 'complete', 'models', 'paste-text', 'attach', 'tab-new', 'tab-close', 'tab-resume', 'tab-move', 'tab-start', 'tab-seen', 'auth', 'push-subscribe', 'push', 'notice-history', 'visibility', 'hello', 'screen']

// Why `value` is not a well-formed command, or undefined if it is.
// Commands cross a process boundary, so the host checks before acting.
function invalid(value: unknown): string | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return 'command must be an object'
	let c = value as Record<string, unknown>
	if (!commandTypes.includes(c.type as CommandType)) return `unknown command type ${JSON.stringify(c.type)}`
	let str = (key: string, optional = false) =>
		(optional && c[key] === undefined) || typeof c[key] === 'string' ? undefined : `${c.type}: ${key} must be a string`
	let problem = str('id', true)
	if (problem) return problem
	if (c.type === 'rebase-error') return str('sessionId') ?? str('text')
	if (c.type === 'rebase-apply') {
		let replacements = c.replacements
		if (c.paused !== undefined && typeof c.paused !== 'boolean') return 'rebase-apply: paused must be boolean'
		if (!Number.isSafeInteger(c.base) || (c.base as number) < 0) return 'rebase-apply: base must be a nonnegative record number'
		if ((c.todo === undefined) === (c.plan === undefined)) return 'rebase-apply: provide exactly one of todo or plan'
		if (c.todo !== undefined && typeof c.todo !== 'string') return 'rebase-apply: todo must be text'
		if (replacements !== undefined && (!replacements || typeof replacements !== 'object' || Array.isArray(replacements) || Object.entries(replacements).some(([n, text]) => !/^[1-9]\d*$/.test(n) || typeof text !== 'string'))) return 'rebase-apply: replacements must map record numbers to text'
		return str('sessionId') ?? str('recoveryPath', true) ?? (c.plan === undefined ? undefined : rebase.invalid(c.plan))
	}
	// The version reaches git as a revision: only a short hash, never an option.
	if (c.type === 'hello') return !Number.isInteger(c.pid) ? 'hello: pid must be an integer' : c.version !== undefined && !/^[0-9a-f]{4,40}(\+[0-9a-f]{7})?$/.test(String(c.version)) ? 'hello: version must be a short hash, optionally +7 hex digits' : c.newCode !== undefined && c.newCode !== true ? 'hello: newCode must be true when present' : undefined
	if (c.type === 'screen') {
		let size = (n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 10000
		if (!size(c.cols) || !size(c.rows)) return 'screen: cols and rows must be integers from 1 to 10000'
		return str('term', true) ?? (((c.term as string | undefined)?.length ?? 0) > 200 ? 'screen: term exceeds 200 characters' : undefined)
	}
	if (c.type === 'find-cancel') return undefined
	if (c.type === 'find') {
		let kinds = c.kinds
		let valid = kinds === undefined || (Array.isArray(kinds) && kinds.every((k) => ['text', 'thinking', 'tools', 'other'].includes(k)))
		return str('request') ?? str('query') ?? ((c.query as string).length > 4096 ? 'find: query exceeds 4096 characters' : valid ? undefined : 'find: invalid kinds')
	}
	if (c.type === 'auth') return c.link === undefined || typeof c.link === 'boolean' ? undefined : 'auth: link must be a boolean'
	if (c.type === 'create') return str('cwd') ?? str('model', true) ?? str('name', true)
	if (c.type === 'open-newest') return str('cwd', true)
	if (c.type === 'tab-new') return str('cwd') ?? str('after', true)
	if (c.type === 'push-subscribe') {
		let s = c.subscription as Record<string, unknown> | undefined
		let keys = s?.keys as Record<string, unknown> | undefined
		let device = c.device === undefined || (typeof c.device === 'string' && c.device.length <= 80)
		return s && keys && device && typeof s.endpoint === 'string' && typeof keys.p256dh === 'string' && typeof keys.auth === 'string' ? undefined : 'push-subscribe: invalid subscription'
	}
	if (c.type === 'notice-history') return undefined
	if (c.type === 'push') return ['list', 'remove', 'test'].includes(c.action as string) ? str('endpoint', c.action === 'list') : 'push: invalid action'
	if (c.type === 'visibility') return str('sessionId') ?? (typeof c.visible === 'boolean' ? undefined : 'visibility: visible must be a boolean')
	if (c.type === 'tab-start') return str('cwd', true) ?? str('last', true)
	if (c.type === 'tab-resume') return str('sessionId', true)
	if (c.type === 'history' && !(Number.isInteger(c.before) && (c.before as number) >= 0)) return 'history: before must be an offset'
	if (c.type === 'tab-move' && !Number.isInteger(c.index)) return 'tab-move: index must be an integer'
	if (c.type === 'submit' && c.delivery !== undefined && !['queue', 'interject', 'interrupt'].includes(c.delivery as string)) return 'submit: delivery must be queue, interject or interrupt'
	for (let flag of ['queue', 'amend']) if (c.type === 'submit' && c[flag] !== undefined && typeof c[flag] !== 'boolean') return `submit: ${flag} must be a boolean`
	if (c.type === 'draft' && c.base !== undefined && !Number.isInteger(c.base)) return 'draft: base must be an integer'
	if (c.type === 'answer') {
		let a = c.answers
		let strings = a && typeof a === 'object' && !Array.isArray(a) && Object.values(a).every((v) => typeof v === 'string')
		return str('sessionId') ?? str('question') ?? (strings ? undefined : 'answer: answers must map names to strings')
	}
	if (c.type === 'attach') return str('sessionId') ?? str('mediaType') ?? str('data') ?? str('name', true)
	if (c.type === 'paste-text') return str('sessionId') ?? str('name')
	if (c.type === 'submit' && c.rewind !== undefined && !(Number.isSafeInteger(c.rewind) && (c.rewind as number) > 0)) return 'submit: rewind must be a record number'
	if (c.type === 'queue-edit' || c.type === 'queue-edit-cancel') return str('sessionId') ?? str('edit') ?? (c.type === 'queue-edit' ? str('message') : undefined)
	if (c.type === 'submit') {
		if (c.queueEdit !== undefined && (c.amend !== true || c.edits === undefined || c.queue === true || c.delivery === 'queue' || c.rewind !== undefined)) return 'submit: queueEdit requires amend and edits, without queue, delivery queue or rewind'
		return str('sessionId') ?? str('text') ?? str('edits', true) ?? str('queueEdit', true)
	}
	return str('sessionId') ?? (c.type === 'draft' || c.type === 'complete' ? str('text') : undefined)
}

export const commandCheck = { commandTypes, invalid }
