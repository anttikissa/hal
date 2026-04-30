// Memory guard — warns when RSS gets high and can quit before the process
// grows without bound. Thresholds live in config so users can tune or disable
// them without editing code.

import { appendFileSync, mkdirSync } from 'fs'
import { client } from './client.ts'
import { STATE_DIR } from './state.ts'
import { ason } from './utils/ason.ts'
import { log } from './utils/log.ts'

const config = {
	warnBytes: 1_500_000_000,
	killBytes: 2_000_000_000,
	checkIntervalMs: 1_000,
	exitDelayMs: 500,
}

const state = {
	warnedHighMemory: false,
	exitingForMemory: false,
}

type DiagnosticReason = 'warning' | 'limit-exceeded' | 'uncaught-exception'

const DIAGNOSTIC_PATH = `${STATE_DIR}/oom.asonl`

const io = {
	readRss: (): number => process.memoryUsage().rss,
	addEntry: (text: string, type: 'info' | 'warning' | 'error' = 'info'): void => {
		client.addEntry(text, type)
	},
	scheduleExit: (delayMs: number): void => {
		setTimeout(() => process.exit(0), delayMs)
	},
	writeDiagnostic: (reason: DiagnosticReason, rss: number, error?: unknown): void => {
		writeDiagnostic(reason, rss, error)
	},
}

function formatMemory(bytes: number): string {
	return `${(bytes / 1_000_000_000).toFixed(2)} GB RSS`
}

function errorInfo(error: unknown): Record<string, unknown> | undefined {
	if (!error) return undefined
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		}
	}
	return { message: String(error) }
}

function memoryUsageSnapshot(): Record<string, number> {
	const out: Record<string, number> = {}
	for (const [key, value] of Object.entries(process.memoryUsage())) {
		if (typeof value === 'number') out[key] = value
	}
	return out
}

function writeDiagnostic(reason: DiagnosticReason, rss: number, error?: unknown): void {
	const record = {
		ts: new Date().toISOString(),
		reason,
		pid: process.pid,
		ppid: process.ppid,
		cwd: process.cwd(),
		uptimeSec: Math.round(process.uptime()),
		rss,
		memory: memoryUsageSnapshot(),
		argv: process.argv,
		error: errorInfo(error),
	}

	try {
		mkdirSync(STATE_DIR, { recursive: true })
		appendFileSync(DIAGNOSTIC_PATH, `${ason.stringify(record, 'short')}\n`)
	} catch (err) {
		log.error('Failed to write OOM diagnostic', { message: err instanceof Error ? err.message : String(err) })
	}
}

function errorText(error: unknown): string {
	if (error instanceof Error) return `${error.name}\n${error.message}\n${error.stack ?? ''}`.toLowerCase()
	return String(error).toLowerCase()
}

function looksLikeOom(error: unknown): boolean {
	const text = errorText(error)
	return text.includes('out of memory') || text.includes('allocation failed') || text.includes('cannot allocate memory')
}

function recordPossibleOom(error: unknown): boolean {
	if (!looksLikeOom(error)) return false
	io.writeDiagnostic('uncaught-exception', io.readRss(), error)
	return true
}

function reset(): void {
	state.warnedHighMemory = false
	state.exitingForMemory = false
}

function tick(rss = io.readRss()): void {

	if (config.warnBytes > 0 && rss >= config.warnBytes && !state.warnedHighMemory) {
		state.warnedHighMemory = true
		io.addEntry(`Memory high: ${formatMemory(rss)}`, 'warning')
		io.writeDiagnostic('warning', rss)
	}

	if (config.killBytes <= 0 || rss < config.killBytes || state.exitingForMemory) return

	state.exitingForMemory = true
	io.addEntry(`Memory limit exceeded: ${formatMemory(rss)}. Quitting.`, 'error')
	io.writeDiagnostic('limit-exceeded', rss)
	io.scheduleExit(config.exitDelayMs)
}

export const memory = {
	config,
	state,
	io,
	formatMemory,
	reset,
	tick,
	writeDiagnostic,
	recordPossibleOom,
	looksLikeOom,
	DIAGNOSTIC_PATH,
}
