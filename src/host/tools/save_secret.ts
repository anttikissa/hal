// Prompt the user for a secret in a hidden field and write NAME=value
// atomically to an env file on the host. The value never enters history,
// events, logs or model input (task ydz).

import { randomBytes } from 'crypto'
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'fs'
import { basename, dirname, join, resolve } from 'path'
import type { ToolCallBlock, ToolResultBlock } from '../../common/blocks.ts'
import type { Answers, Form } from '../../common/forms.ts'
import type { HistoryRecord } from '../../common/replay.ts'
import { paths } from '../paths.ts'
import { sessions } from '../sessions.ts'
import { toolPresentations } from '../tool-presentation.ts'
import { tools, type Tool, type ToolContext } from '../tools.ts'

// Configuration: true puts the whole help in the system prompt; false
// lists only the summary under Other tools (HELP <TOOL> shows the rest).
const inPrompt = false
const enableIf = '$session_interactive'
const summary =
	'/* Add or update API_KEY in .env */ { file: ".env", name: "API_KEY" } // prompt user securely for the key; model never sees it'
const help = `## SAVE_SECRET

Prompt the user for a secret in a hidden field and write NAME=value into an env file (mode 0600 if new). The value goes only to the host and never reaches the model, history, events or logs.
SAVE_SECRET /* <purpose> */ { file, name }
	file: string    env file path (absolute or relative to cwd)
	name: string    env variable name ([A-Za-z_][A-Za-z0-9_]*)
- Creates the file with mode 0600 if missing; otherwise preserves permissions.
- Replaces an existing NAME= line or appends NAME=value.
- Returns only "saved", "canceled", or an error.`

const parameters = {
	type: 'object',
	properties: {
		file: { type: 'string' },
		name: { type: 'string' },
		description: { type: 'string' },
	},
	required: ['file', 'name'],
	additionalProperties: false,
}

const syntax = {
	usage: [
		'SAVE_SECRET { file, name } // prompt user securely for a key and write it to an env file; model never sees it',
	],
	positional: [] as string[],
}

const envNameRe = /^[A-Za-z_][A-Za-z0-9_]*$/
const allowedFields = new Set(['file', 'name', 'description'])

type Outcome = { output: string; isError?: true }

const state = {
	// Per-call outcomes from saveSecret.answer when a write fails (keyed by sessionId:callId).
	outcomes: new Map<string, Outcome>(),
}

function validate(cwd: string, input: Record<string, unknown>): { target: string; name: string } {
	for (let key of Object.keys(input)) {
		if (!allowedFields.has(key)) throw new Error(`save_secret has no field '${key}'`)
	}
	let file = input.file
	if (typeof file !== 'string' || !file.trim() || file.includes('\0'))
		throw new Error('file must be a non-empty path without NUL bytes')
	let name = input.name
	if (typeof name !== 'string' || !envNameRe.test(name))
		throw new Error(`name must match [A-Za-z_][A-Za-z0-9_]*; got ${JSON.stringify(name)}`)
	let target = resolve(cwd, paths.expand(file))
	let dir = dirname(target)
	if (!existsSync(dir) || !statSync(dir).isDirectory())
		throw new Error(`directory does not exist: ${paths.display(dir)}`)
	accessSync(dir, constants.W_OK)
	if (existsSync(target)) {
		if (statSync(target).isDirectory()) throw new Error(`file is a directory: ${paths.display(target)}`)
		accessSync(target, constants.W_OK)
	}
	return { target, name }
}

function keyPattern(name: string): RegExp {
	return new RegExp(`(^|[\\r\\n])(${name}=)[^\\r\\n]*`)
}

function hasKey(target: string, name: string): boolean {
	return existsSync(target) && keyPattern(name).test(readFileSync(target, 'utf8'))
}

function updateEnvText(existing: string, name: string, value: string): string {
	let re = keyPattern(name)
	if (re.test(existing)) return existing.replace(re, (_, pre, eq) => `${pre}${eq}${value}`)
	let nl = existing.includes('\r\n') ? '\r\n' : '\n'
	let sep = existing && !/[\r\n]$/.test(existing) ? nl : ''
	return `${existing}${sep}${name}=${value}${nl}`
}

function writeEnv(target: string, name: string, value: string): void {
	if (!envNameRe.test(name)) throw new Error(`name must match [A-Za-z_][A-Za-z0-9_]*; got ${JSON.stringify(name)}`)
	if (typeof value !== 'string') throw new Error('secret value must be a string')
	if (/[\r\n]/.test(value)) throw new Error('secret value must not contain a line break')
	if (value.includes('\0')) throw new Error('secret value must not contain a NUL byte')
	let existed = existsSync(target)
	let mode = existed ? statSync(target).mode & 0o777 : 0o600
	let existing = existed ? readFileSync(target, 'utf8') : ''
	let next = updateEnvText(existing, name, value)
	let tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
	try {
		writeFileSync(tmp, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
		chmodSync(tmp, mode)
		renameSync(tmp, target)
	} catch (e) {
		try {
			unlinkSync(tmp)
		} catch {}
		throw e
	}
}

// The secret prompt for a valid SAVE_SECRET call, or undefined if the call
// is invalid (so run() reports the validation error directly without asking).
function form(call: ToolCallBlock, cwd: string, sessionId?: string): Form | undefined {
	if (call.name !== 'save_secret') return undefined
	if (sessionId && !tools.allowed(sessionId).some((t) => t.name === 'save_secret')) return undefined
	let checked: { target: string; name: string }
	try {
		checked = saveSecret.validate(cwd, call.input)
	} catch {
		return undefined
	}
	let purpose = typeof call.input.description === 'string' ? call.input.description.replace(/\s+/g, ' ').trim() : ''
	let shown = paths.display(checked.target)
	let lines = [
		purpose || `Save ${checked.name} to ${shown}`,
		`File: ${shown}`,
		...(saveSecret.hasKey(checked.target, checked.name) ? ['This replaces the current value.'] : []),
	]
	return {
		text: lines.join('\n'),
		fields: [{ type: 'secret', name: 'secret', label: checked.name }],
		skip: true,
	}
}

// Handles an answered SAVE_SECRET question on the host immediately, before
// answers are discarded. Never stores or returns the secret value.
function answer(
	sessionId: string,
	records: HistoryRecord[],
	callId: string | undefined,
	answers: Answers,
): { canceled?: true } | undefined {
	if (callId === undefined) return undefined
	let found = records.findLast((r) => r.type === 'assistant' && r.block.type === 'tool_call' && r.block.id === callId)
	if (found?.type !== 'assistant' || found.block.type !== 'tool_call' || found.block.name !== 'save_secret')
		return undefined
	let call = found.block
	let value = answers.secret
	if (value === '') return { canceled: true }
	let cwd = sessions.open(sessionId).cwd
	try {
		let { target, name } = saveSecret.validate(cwd, call.input)
		saveSecret.writeEnv(target, name, value!)
		return {}
	} catch (e: any) {
		saveSecret.state.outcomes.set(`${sessionId}:${call.id}`, {
			output: `Error: ${e?.message ?? e}`,
			isError: true,
		})
		return { canceled: true }
	}
}

function result(sessionId: string, call: ToolCallBlock, saved: boolean): ToolResultBlock {
	let key = `${sessionId}:${call.id}`
	let stored = saveSecret.state.outcomes.get(key)
	saveSecret.state.outcomes.delete(key)
	let res: ToolResultBlock = stored
		? { type: 'tool_result', id: call.id, output: stored.output, ...(stored.isError && { isError: true }) }
		: { type: 'tool_result', id: call.id, output: saved ? 'saved' : 'canceled' }
	return toolPresentations.attach(call, res)
}

function reset(): void {
	saveSecret.state.outcomes.clear()
}

async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	saveSecret.validate(ctx.cwd, input)
	throw new Error('SAVE_SECRET requires user input through its secret prompt')
}

export const saveSecret = {
	state,
	validate,
	hasKey,
	writeEnv,
	form,
	answer,
	result,
	reset,
}

export const tool: Tool = { name: 'save_secret', inPrompt, enableIf, summary, help, parameters, syntax, run }
