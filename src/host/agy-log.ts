// Reads Antigravity (`agy acp`) log slices for one process so Hal never
// hides backend errors (such as 403 VALIDATION_REQUIRED with a verify URL)
// that agy collapses into a bare "⚠ ..." message chunk over ACP, and learns
// the signed-in email without touching the OS Keychain or token files.
// Task xbp.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { homedir } from 'os'
import type { ErrorEvent, Usage } from '../common/blocks.ts'
import { strings } from '../common/strings.ts'
import { agyAccounts } from './agy-accounts.ts'
import { clock } from './clock.ts'

export type AgyLogFailure = {
	message: string
	detail: string
	code?: number
	status?: string
	reason?: string
	url?: string
	learnMore?: string
}

const maxSlice = 256 * 1024

function logDir(geminiDir?: string): string {
	return `${geminiDir ?? `${homedir()}/.gemini`}/antigravity-cli/log`
}

// Finds the ACP server log file created by process `pid`.
function find(pid: number | undefined, geminiDir?: string): string | undefined {
	if (!pid) return undefined
	let dir = logDir(geminiDir)
	try {
		let suffix = `-${pid}.log`
		let match = readdirSync(dir)
			.filter((f) => f.startsWith('acp-server-') && f.endsWith(suffix))
			.sort()
			.at(-1)
		return match ? `${dir}/${match}` : undefined
	} catch {
		return undefined
	}
}

function size(path: string | undefined): number {
	if (!path || !existsSync(path)) return 0
	try {
		return statSync(path).size
	} catch {
		return 0
	}
}

// Reads bytes appended to `path` since `offset`, capped at maxSlice.
function readFrom(path: string | undefined, offset: number): string {
	if (!path) return ''
	let fd: number | undefined
	try {
		let total = statSync(path).size
		if (total <= offset) return ''
		let start = Math.max(offset, total - maxSlice)
		let len = total - start
		let buf = Buffer.alloc(len)
		fd = openSync(path, 'r')
		let read = readSync(fd, buf, 0, len, start)
		return buf.toString('utf8', 0, read)
	} catch {
		return ''
	} finally {
		if (fd !== undefined) closeSync(fd)
	}
}

// Extracts the authenticated Google email logged by agy at startup.
function email(text: string): string | undefined {
	let m =
		/OAuth: authenticated successfully as ([^\s,]+@[^\s,]+)/.exec(text) ??
		/applyAuthResult: email=([^\s,]+@[^\s,]+)/.exec(text)
	return m?.[1]
}

// Standalone single-line "⚠ ..." banner sent by agy for executor errors.
function warningText(text: string): string | undefined {
	let m = /^\s*⚠\s*(.+?)\s*$/.exec(text)
	return m?.[1]
}

function isVerification(text: string): boolean {
	return /^\s*⚠\s*Verification Required\s*$/i.test(text)
}

// Parses the last balanced JSON object starting at `start` in `text`.
function parseJsonAt(text: string, start: number): any {
	let depth = 0
	let inString = false
	let escaped = false
	for (let i = start; i < text.length; i++) {
		let ch = text[i]!
		if (inString) {
			if (escaped) escaped = false
			else if (ch === '\\') escaped = true
			else if (ch === '"') inString = false
			continue
		}
		if (ch === '"') inString = true
		else if (ch === '{') depth++
		else if (ch === '}') {
			depth--
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(start, i + 1))
				} catch {
					return undefined
				}
			}
		}
	}
	return undefined
}

// Extracts the last Google backend JSON error or executor error from an
// ACP log slice so Hal surfaces the full reason and verify URL.
function parseFailure(slice: string): AgyLogFailure | undefined {
	let parsed: any
	let marker = 'Failed to make code assist backend request ('
	let at = slice.lastIndexOf(marker)
	if (at >= 0) {
		let brace = slice.indexOf('{', at + marker.length)
		if (brace >= 0) parsed = parseJsonAt(slice, brace)
	}
	if (!parsed) {
		let errKey = slice.lastIndexOf('"error": {')
		if (errKey >= 0) {
			let brace = slice.lastIndexOf('{', errKey)
			if (brace >= 0) parsed = parseJsonAt(slice, brace)
		}
	}
	let err = parsed?.error
	if (err && typeof err === 'object') {
		let code = typeof err.code === 'number' ? err.code : undefined
		let status = typeof err.status === 'string' ? err.status : undefined
		let details = Array.isArray(err.details) ? err.details : []
		let info = details.find((d: any) => typeof d?.reason === 'string' || d?.metadata)
		let help = details.find((d: any) => Array.isArray(d?.links))
		let reason = typeof info?.reason === 'string' ? info.reason : undefined
		let meta = info?.metadata && typeof info.metadata === 'object' ? info.metadata : {}
		let url =
			(typeof meta.validation_url === 'string' && meta.validation_url) ||
			(typeof help?.links?.[0]?.url === 'string' && help.links[0].url) ||
			undefined
		let learnMore =
			(typeof meta.validation_learn_more_url === 'string' && meta.validation_learn_more_url) ||
			(typeof help?.links?.[1]?.url === 'string' && help.links[1].url) ||
			undefined
		let message =
			(typeof err.message === 'string' && err.message) ||
			(typeof meta.validation_error_message === 'string' && meta.validation_error_message) ||
			'Antigravity backend error'
		let tags = [code ? `HTTP ${code}` : '', status ?? '', reason ?? ''].filter(Boolean).join(' ')
		let head =
			reason === 'VALIDATION_REQUIRED'
				? `Verification required${tags ? ` (${tags})` : ''}: ${message}`
				: `${tags || 'agy error'}: ${message}`
		let lines = [head]
		if (url) lines.push(`Verify: ${url}`)
		if (learnMore && learnMore !== url) lines.push(`Learn more: ${learnMore}`)
		return { message, detail: lines.join('\n'), code, status, reason, url, learnMore }
	}
	let execMatches = [...slice.matchAll(/agent executor error:\s*([^\n]+)/g)]
	let lastExec = execMatches.at(-1)?.[1]?.trim()
	if (lastExec) return { message: lastExec, detail: lastExec }
	return undefined
}

export const agyLog = {
	find,
	size,
	readFrom,
	email,
	warningText,
	isVerification,
	parseFailure,
	warningError,
	extractUsage,
	appendStderr,
	formatError,
	rpcError,
	waitingForPermission,
}

// Converts an agy "⚠ ..." warning banner into a Hal error event by reading
// the turn's ACP log slice; returns undefined if it was genuine model text.
function warningError(
	warning: string,
	logPath: string | undefined,
	offset: number,
	account: string,
	sessionId: string,
): ErrorEvent | undefined {
	let parsed = agyLog.parseFailure(agyLog.readFrom(logPath, offset))
	if (agyLog.isVerification(warning) || parsed?.reason === 'VALIDATION_REQUIRED') {
		let message = parsed?.detail ?? `Verification required${logPath ? ` (see ${logPath})` : ''}`
		agyAccounts.needsVerification(account, parsed?.message ?? 'Verification required', parsed?.url, sessionId)
		let rotate = agyAccounts.hasOther(account)
		return {
			type: 'error',
			message,
			status: parsed?.code ?? 403,
			...(rotate && { failure: 'auth', retryAt: clock.now() }),
		}
	}
	if (!parsed) return undefined
	return { type: 'error', message: parsed.detail, ...(parsed.code && { status: parsed.code }) }
}

function extractUsage(u: any): Usage {
	let usage: Usage = {}
	if (!u) return usage
	if (typeof u.inputTokens === 'number' && u.inputTokens > 0) usage.input = u.inputTokens
	if (typeof u.cachedReadTokens === 'number' && u.cachedReadTokens > 0) usage.cacheRead = u.cachedReadTokens
	if (typeof u.cachedWriteTokens === 'number' && u.cachedWriteTokens > 0) usage.cacheWrite = u.cachedWriteTokens
	if (typeof u.outputTokens === 'number' && u.outputTokens > 0) usage.output = u.outputTokens
	return usage
}

const stderrLimit = 64_000

function appendStderr(prev: string, line: string): string {
	let next = `${prev}${line}\n`
	return next.length > stderrLimit ? strings.sliceText(next, -stderrLimit) : next
}

const authHint =
	/\b(unauthenticated|not logged in|login required|sign[- ]?in|auth(?:entication)? (?:required|failed|expired)|token expired|credentials? (?:expired|invalid|missing)|oauth)\b/i

function formatError(head: string, detail?: string, stderr?: string): string {
	let parts = [head]
	if (detail && !head.includes(detail)) parts.push(detail)
	let errText = stderr?.trim()
	if (errText && !parts.some((p) => p.includes(errText))) parts.push(`stderr:\n${errText}`)
	let full = parts.join('\n')
	if (authHint.test(full)) full += '\nSign in again with /login agy (or `agy acp --login` for Keychain).'
	return full
}

function rpcError(err: any, stderr?: string): Error {
	let code = err?.code !== undefined ? ` (${err.code})` : ''
	let msg = typeof err?.message === 'string' && err.message ? err.message : 'ACP error'
	let data =
		err?.data === undefined ? undefined : typeof err.data === 'string' ? err.data : JSON.stringify(err.data, null, 2)
	return new Error(agyLog.formatError(`agy${code}: ${msg}`, data, stderr))
}

function waitingForPermission(err: unknown): boolean {
	return err instanceof Error && /waiting for a permission or question answer/i.test(err.message)
}
