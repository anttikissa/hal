// /login agy: runs `SSH_CONNECTION=... agy acp --gemini-dir <dir> --login`
// so agy keeps the Google OAuth token in its own file while Hal records
// only `{ email, geminiDir }` in secrets/auth.ason.
// The child process stays alive between showing the URL and receiving the
// pasted authorization code (in memory: a restart expires the prompt).
// Errors never echo the pasted code. Task xbp.

import { mkdirSync, rmSync } from 'fs'
import { dirname, resolve } from 'path'
import { agy } from './agy.ts'
import { agyAccounts } from './agy-accounts.ts'
import { auth } from './auth.ts'
import { paths } from './paths.ts'
import { provider } from './provider.ts'
import { slash } from './slash.ts'

type Pending = {
	sessionId?: string
	proc: ReturnType<typeof Bun.spawn>
	absDir: string
	relDir: string
	stdout: string
	stderr: string
	outDone: Promise<void>
	errDone: Promise<void>
	timer: ReturnType<typeof setTimeout>
}

const state = {
	pending: new Map<string, Pending>(),
	hooked: false,
}

function available(): boolean {
	let p = Object.hasOwn(provider.state.providers, 'agy') ? provider.state.providers.agy : undefined
	if (p?.available) return p.available()
	return !!Bun.which(agy.command()[0]!)
}

function cleanupDir(absDir: string): void {
	try {
		rmSync(dirname(absDir), { recursive: true, force: true })
	} catch {}
}

function kill(entry: Pending, removeDir: boolean): void {
	clearTimeout(entry.timer)
	try {
		entry.proc.kill()
	} catch {}
	if (removeDir) cleanupDir(entry.absDir)
}

function cancel(id?: string): void {
	if (id !== undefined) {
		let entry = state.pending.get(id)
		if (!entry) return
		state.pending.delete(id)
		kill(entry, true)
		return
	}
	for (let [k, entry] of state.pending) {
		state.pending.delete(k)
		kill(entry, true)
	}
}

function cancelSession(sessionId: string): void {
	for (let [k, entry] of state.pending) {
		if (entry.sessionId !== sessionId) continue
		state.pending.delete(k)
		kill(entry, true)
	}
}

function ensureHook(): void {
	if (state.hooked) return
	state.hooked = true
	slash.state.dismissed.add((sessionId) => loginAgy.cancelSession(sessionId))
}

function redact(text: string, secret: string): string {
	let out = text
	if (secret) out = out.split(secret).join('<redacted>')
	return out.replace(/([?&]code=)[^&\s]+/gi, '$1<redacted>')
}

// Spawns `agy acp --gemini-dir <new dir> --login` and waits until it prints
// the Google OAuth URL.
async function start(sessionId?: string): Promise<{ id: string; url: string }> {
	ensureHook()
	if (sessionId) loginAgy.cancelSession(sessionId)
	let id = crypto.randomUUID().slice(0, 8)
	let relDir = `state/agy/${id}/gemini`
	let absDir = resolve(paths.home(), relDir)
	mkdirSync(absDir, { recursive: true, mode: 0o700 })
	let args = [...agy.command(), 'acp', '--gemini-dir', absDir, '--login']
	let proc: ReturnType<typeof Bun.spawn>
	try {
		proc = Bun.spawn(args, {
			env: { ...process.env, SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 22' },
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
		})
	} catch (e) {
		cleanupDir(absDir)
		throw new Error(`agy login failed to start: ${e instanceof Error ? e.message : e}`)
	}
	let entry: Pending = {
		sessionId,
		proc,
		absDir,
		relDir,
		stdout: '',
		stderr: '',
		outDone: Promise.resolve(),
		errDone: Promise.resolve(),
		timer: setTimeout(() => loginAgy.cancel(id), loginAgy.timeoutMs),
	}
	entry.timer.unref?.()

	let urlReady = Promise.withResolvers<string>()
	let checkUrl = () => {
		let m = /(https:\/\/[^\s]+)/.exec(entry.stdout)
		if (m && entry.stdout.includes('\n', m.index + m[1]!.length)) urlReady.resolve(m[1]!)
	}
	let drain = async (stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void) => {
		let decoder = new TextDecoder()
		for await (let chunk of stream) onChunk(decoder.decode(chunk, { stream: true }))
		let tail = decoder.decode()
		if (tail) onChunk(tail)
	}
	entry.outDone = drain(proc.stdout as ReadableStream<Uint8Array>, (text) => {
		entry.stdout += text
		checkUrl()
	})
	entry.errDone = drain(proc.stderr as ReadableStream<Uint8Array>, (text) => {
		entry.stderr += text
	})
	void proc.exited.then(async (code) => {
		await Promise.all([entry.outDone.catch(() => {}), entry.errDone.catch(() => {})])
		let detail = [entry.stdout.trim(), entry.stderr.trim()].filter(Boolean).join('\n')
		urlReady.reject(new Error(`agy login exited before printing a URL (code ${code})${detail ? `:\n${detail}` : ''}`))
	})

	let startTimer = setTimeout(
		() => urlReady.reject(new Error('agy login timed out waiting for OAuth URL')),
		loginAgy.startTimeoutMs,
	)
	startTimer.unref?.()
	try {
		let url = await urlReady.promise
		state.pending.set(id, entry)
		return { id, url }
	} catch (e) {
		kill(entry, true)
		throw e
	} finally {
		clearTimeout(startTimer)
	}
}

// Sends the pasted code (or callback URL) to the waiting `agy --login`
// process, reads "Logged in as <email>.", and records the account in auth.ason.
async function finish(id: string, pasted: string): Promise<string> {
	try {
		let entry = state.pending.get(id)
		if (!entry) throw new Error('agy login expired; run /login agy again')
		state.pending.delete(id)
		clearTimeout(entry.timer)
		let code = pasted.trim()
		if (!code) {
			kill(entry, true)
			throw new Error('no code given; run /login agy again')
		}
		try {
			let stdin = entry.proc.stdin as import('bun').FileSink
			stdin.write(`${code}\n`)
			stdin.flush()
			stdin.end()
		} catch (e) {
			kill(entry, true)
			throw new Error(redact(`agy login could not send code: ${e instanceof Error ? e.message : e}`, code))
		}
		let finishTimer: ReturnType<typeof setTimeout> | undefined
		let timedOut = new Promise<never>((_, reject) => {
			finishTimer = setTimeout(() => {
				kill(entry, true)
				reject(new Error('agy login timed out after submitting the code; run /login agy again'))
			}, loginAgy.finishTimeoutMs)
			finishTimer.unref?.()
		})
		let exitCode: number
		try {
			exitCode = await Promise.race([entry.proc.exited, timedOut])
			await Promise.all([entry.outDone.catch(() => {}), entry.errDone.catch(() => {})])
		} finally {
			clearTimeout(finishTimer)
		}
		let match = /Logged in as ([^\r\n]+?)\.?(?:\r?\n|$)/.exec(entry.stdout)
		let email = match?.[1]?.trim()
		if (exitCode !== 0 || !email) {
			cleanupDir(entry.absDir)
			let detail = [entry.stderr.trim(), entry.stdout.trim()].filter(Boolean).join('\n')
			throw new Error(redact(`agy login failed (code ${exitCode})${detail ? `:\n${detail}` : ''}`, code))
		}
		agyAccounts.save(email, entry.relDir)
		return email
	} finally {
		auth.state.logins++
	}
}

export const loginAgy = {
	state,
	timeoutMs: 15 * 60_000,
	startTimeoutMs: 15_000,
	finishTimeoutMs: 60_000,
	available,
	start,
	finish,
	cancel,
	cancelSession,
}
