// Prompt the user for a secret in a hidden field and write NAME=value
// atomically (mode 0600) to an env file on the host. The value never enters
// history, events, logs or model input (task ydz).

import { spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import {
	chmodSync,
	existsSync,
	lstatSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
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
const summary =
	'/* Add or update API_KEY in .env */ { file: ".env", name: "API_KEY" } // prompt user securely for the key; model never sees it'
const help = `## SAVE_SECRET

Prompt the user for a secret in a hidden field and write NAME=value into an env file (mode 0600). The value goes only to the host and never reaches the model, history, events or logs.
SAVE_SECRET /* <purpose> */ { file, name }
	file: string    env file path (absolute or relative to cwd); must not be tracked in git (git-ignored files are allowed)
	name: string    env variable name ([A-Z_][A-Z0-9_]*)
- Creates the file if missing, replaces an existing NAME= line, or appends NAME=value.
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

const envNameRe = /^[A-Z_][A-Z0-9_]*$/
const allowedFields = new Set(['file', 'name', 'description'])

type Outcome = { output: string; isError?: true }

const state = {
	// Per-call outcomes from saveSecret.answer when a write fails (keyed by sessionId:callId).
	outcomes: new Map<string, Outcome>(),
}

function canonical(path: string, depth = 0): string {
	if (depth > 40) throw new Error(`too many symbolic links: ${paths.display(path)}`)
	let abs = resolve(path)
	try {
		return realpathSync(abs)
	} catch (e: any) {
		if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e
		try {
			if (lstatSync(abs).isSymbolicLink()) return canonical(resolve(dirname(abs), readlinkSync(abs)), depth + 1)
		} catch (le: any) {
			if (le.code !== 'ENOENT' && le.code !== 'ENOTDIR') throw le
		}
		let parent = dirname(abs)
		if (parent === abs) return abs
		return join(canonical(parent, depth), basename(abs))
	}
}

function nearestExistingDir(path: string): string {
	let cur = dirname(resolve(path))
	while (true) {
		try {
			if (statSync(cur).isDirectory()) return cur
		} catch {}
		let parent = dirname(cur)
		if (parent === cur) return cur
		cur = parent
	}
}

function checkGitPath(path: string): void {
	let abs = resolve(path)
	if (abs.split('/').includes('.git')) throw new Error(`refused: ${paths.display(abs)} is inside .git`)
	let dir = nearestExistingDir(abs)
	let top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
	if (top.error) throw new Error(`git check failed: ${top.error.message}`)
	if (top.status !== 0) {
		if (/not a git repository/i.test(top.stderr ?? '')) return
		throw new Error(`git check failed: ${(top.stderr || '').trim() || `exit ${top.status}`}`)
	}
	let root = top.stdout.trim()
	let rootReal = realpathSync(root)
	let rel = relative(rootReal, canonical(abs))
	if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return
	let ignored = spawnSync('git', ['-C', root, 'check-ignore', '--quiet', '--', rel], { encoding: 'utf8' })
	if (ignored.error) throw new Error(`git check-ignore failed: ${ignored.error.message}`)
	if (ignored.status === 0) return
	if (ignored.status === 1)
		throw new Error(`refused: ${paths.display(abs)} is inside a git repository and not git-ignored`)
	throw new Error(`git check-ignore failed: ${(ignored.stderr || '').trim() || `exit ${ignored.status}`}`)
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
		throw new Error(`name must match [A-Z_][A-Z0-9_]*; got ${JSON.stringify(name)}`)
	let target = resolve(cwd, paths.expand(file))
	let canon = canonical(target)
	checkGitPath(target)
	if (canon !== target) checkGitPath(canon)
	let dir = dirname(target)
	if (!existsSync(dir) || !statSync(dir).isDirectory())
		throw new Error(`directory does not exist: ${paths.display(dir)}`)
	if (existsSync(target) && statSync(target).isDirectory())
		throw new Error(`file is a directory: ${paths.display(target)}`)
	return { target, name }
}

function linePattern(name: string): RegExp {
	return new RegExp(`^(export\\s+)?${name}=`)
}

function hasKey(target: string, name: string): boolean {
	if (!existsSync(target)) return false
	let text = readFileSync(target, 'utf8')
	let re = linePattern(name)
	return text.split('\n').some((line) => re.test(line.endsWith('\r') ? line.slice(0, -1) : line))
}

function updateEnvText(existing: string, name: string, value: string): string {
	if (!existing) return `${name}=${value}\n`
	let trailing = existing.endsWith('\n')
	let rawLines = (trailing ? existing.slice(0, -1) : existing).split('\n')
	let re = linePattern(name)
	let replaced = false
	let out: string[] = []
	for (let raw of rawLines) {
		let cr = raw.endsWith('\r') ? '\r' : ''
		let line = cr ? raw.slice(0, -1) : raw
		let m = re.exec(line)
		if (m) {
			if (!replaced) {
				out.push(`${m[1] ?? ''}${name}=${value}${cr}`)
				replaced = true
			}
			continue
		}
		out.push(raw)
	}
	if (!replaced) {
		let cr = existing.includes('\r\n') ? '\r' : ''
		out.push(`${name}=${value}${cr}`)
		return `${out.join('\n')}\n`
	}
	return `${out.join('\n')}${trailing ? '\n' : ''}`
}

function writeEnv(target: string, name: string, value: string): void {
	if (!envNameRe.test(name)) throw new Error(`name must match [A-Z_][A-Z0-9_]*; got ${JSON.stringify(name)}`)
	if (typeof value !== 'string') throw new Error('secret value must be a string')
	if (/[\r\n]/.test(value)) throw new Error('secret value must not contain a line break')
	if (value.includes('\0')) throw new Error('secret value must not contain a NUL byte')
	let dest = canonical(target)
	let existing = existsSync(dest) ? readFileSync(dest, 'utf8') : ''
	let next = updateEnvText(existing, name, value)
	let tmp = join(dirname(dest), `.${basename(dest)}.${randomBytes(6).toString('hex')}.tmp`)
	try {
		writeFileSync(tmp, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
		chmodSync(tmp, 0o600)
		renameSync(tmp, dest)
		chmodSync(dest, 0o600)
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

export const tool: Tool = { name: 'save_secret', inPrompt, summary, help, parameters, syntax, run }
