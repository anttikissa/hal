// Reads Antigravity (`agy`) 5h and weekly quota windows by invoking
// `agy -p /quota --output-format json`. For accounts with a `geminiDir`,
// runs agy under a temporary HOME with `.gemini` symlinked to that directory
// and SSH_CONNECTION set so agy reads the account's file token instead of
// the OS Keychain. Task xbp.

import { mkdtempSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { agy } from './agy.ts'
import type { AgyAccount } from './agy-accounts.ts'
import { clock } from './clock.ts'
import type { Windows } from './usage.ts'

const AUTH_REQUIRED = /\bauthentication required\b/i

function parse(raw: string): Windows {
	let data: any
	try {
		data = JSON.parse(raw.trim())
	} catch {
		throw new Error(`agy /quota returned invalid JSON${raw.trim() ? `:\n${raw.trim()}` : ''}`)
	}
	if (data?.status && data.status !== 'SUCCESS')
		throw new Error(`agy /quota failed (${data.status})${data.response ? `: ${data.response}` : ''}`)
	let groups = data?.command?.data?.groups
	if (!Array.isArray(groups)) throw new Error('agy /quota returned no quota groups')
	let observed = new Date(clock.now()).toISOString()
	let out: Windows = {}
	for (let group of groups) {
		let buckets = Array.isArray(group?.buckets) ? group.buckets : []
		let geminiGroup = /gemini/i.test(String(group?.name ?? ''))
		for (let b of buckets) {
			if (typeof b?.remaining_fraction !== 'number' || !Number.isFinite(b.remaining_fraction)) continue
			let id = typeof b.id === 'string' ? b.id : ''
			let span =
				b.window === '5h' || id.endsWith('-5h')
					? '5h'
					: b.window === 'weekly' || id.endsWith('-weekly')
						? '7d'
						: undefined
			if (!span) continue
			let isGemini = id.startsWith('gemini-') || (!id && geminiGroup)
			let key = isGemini ? span : `${span}_${id.split('-')[0] || 'other'}`
			let frac = Math.max(0, Math.min(1, b.remaining_fraction))
			let used = frac <= 0 ? 100 : frac >= 1 ? 0 : Math.min(99.9, Math.round((1 - frac) * 1000) / 10)
			let ms = typeof b.reset_time === 'string' ? Date.parse(b.reset_time) : NaN
			out[key] = {
				used,
				...(Number.isFinite(ms) && ms > 0 && { resets: new Date(ms).toISOString() }),
				observed,
			}
		}
	}
	if (!Object.keys(out).length) throw new Error('agy /quota returned no windows')
	return out
}

async function drain(stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void): Promise<void> {
	let decoder = new TextDecoder()
	for await (let chunk of stream) onChunk(decoder.decode(chunk, { stream: true }))
	let tail = decoder.decode()
	if (tail) onChunk(tail)
}

async function fetch(account: AgyAccount): Promise<Windows> {
	let tmpHome: string | undefined
	if (account.geminiDir) {
		tmpHome = mkdtempSync(join(tmpdir(), 'hal-agy-quota-'))
		symlinkSync(account.geminiDir, join(tmpHome, '.gemini'))
	}
	try {
		let args = [...agy.command(), '-p', '/quota', '--output-format', 'json']
		let proc: ReturnType<typeof Bun.spawn>
		try {
			proc = Bun.spawn(args, {
				cwd: tmpHome ?? tmpdir(),
				env: tmpHome ? { ...process.env, HOME: tmpHome, SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 22' } : process.env,
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
			})
		} catch (e) {
			throw new Error(`agy /quota failed to start: ${e instanceof Error ? e.message : e}`)
		}
		let stdout = ''
		let stderr = ''
		let authRequired = false
		let timedOut = false
		let stop = () => {
			try {
				proc.kill()
			} catch {}
		}
		let checkAuth = (text: string) => {
			if (!authRequired && AUTH_REQUIRED.test(text)) {
				authRequired = true
				stop()
			}
		}
		let timer = setTimeout(() => {
			timedOut = true
			stop()
		}, agyQuota.timeoutMs)
		timer.unref?.()
		try {
			let [code] = await Promise.all([
				proc.exited,
				drain(proc.stdout as ReadableStream<Uint8Array>, (t) => {
					stdout += t
					checkAuth(stdout)
				}),
				drain(proc.stderr as ReadableStream<Uint8Array>, (t) => {
					stderr += t
					checkAuth(stderr)
				}),
			])
			if (authRequired) throw new Error('agy /quota: authentication required; run /login agy')
			if (timedOut) throw new Error('agy /quota timed out')
			if (code !== 0) {
				let detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
				throw new Error(`agy /quota exited with code ${code}${detail ? `:\n${detail}` : ''}`)
			}
			return agyQuota.parse(stdout)
		} finally {
			clearTimeout(timer)
		}
	} finally {
		if (tmpHome) rmSync(tmpHome, { recursive: true, force: true })
	}
}

export const agyQuota = {
	timeoutMs: 15_000,
	parse,
	fetch,
}
