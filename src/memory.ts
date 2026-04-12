// Memory guard — warns when RSS gets high and can quit before the process
// grows without bound. Thresholds live in config so users can tune or disable
// them without editing code.

import { client } from './client.ts'

const config = {
	warnBytes: 1_500_000_000,
	limitBytes: 2_000_000_000,
	checkIntervalMs: 1_000,
	exitDelayMs: 500,
}

const state = {
	warnedHighMemory: false,
	exitingForMemory: false,
}

const io = {
	readRss: (): number => process.memoryUsage().rss,
	addEntry: (text: string, type: 'info' | 'error' = 'info'): void => {
		client.addEntry(text, type)
	},
	scheduleExit: (delayMs: number): void => {
		setTimeout(() => process.exit(0), delayMs)
	},
}

function formatMemory(bytes: number): string {
	return `${(bytes / 1_000_000_000).toFixed(2)} GB RSS`
}

function reset(): void {
	state.warnedHighMemory = false
	state.exitingForMemory = false
}

function tick(rss = io.readRss()): void {
	if (config.warnBytes > 0 && rss >= config.warnBytes && !state.warnedHighMemory) {
		state.warnedHighMemory = true
		io.addEntry(`Memory high: ${formatMemory(rss)}`)
	}

	if (config.limitBytes <= 0 || rss < config.limitBytes || state.exitingForMemory) return
	state.exitingForMemory = true
	io.addEntry(`Memory limit exceeded: ${formatMemory(rss)}. Quitting.`, 'error')
	io.scheduleExit(config.exitDelayMs)
}

export const memory = {
	config,
	state,
	io,
	formatMemory,
	reset,
	tick,
}
