import { readdir } from 'fs/promises'
import { existsSync } from 'fs'
import type { Client } from './client.ts'
import { logSnapshot, getDebugLogPath, saveBugReport } from '../debug-log.ts'
import { SESSIONS_DIR } from '../state.ts'
import { loadSessionInfo, timeSince, type SessionMeta } from '../session.ts'


type Handler = (args: string, client: Client) => Promise<void> | void

async function help(_args: string, client: Client): Promise<void> {
	client.log('local.help', `Commands: ${COMMAND_NAMES.map((c) => '/' + c).join(' ')}`)
}

async function model(args: string, client: Client): Promise<void> {
	if (!args) {
		await client.command('model', '')
		client.log('local.queue', 'model status')
		return
	}
	await client.command('model', args)
	client.log('local.queue', `model: ${args}`)
}

async function system(_args: string, client: Client): Promise<void> {
	await client.command('system')
	client.log('local.queue', 'system prompt')
}

async function pause(_args: string, client: Client): Promise<void> {
	await client.command('pause')
	client.log('local.queue', 'pause')
}

async function drop(args: string, client: Client): Promise<void> {
	await client.command('drop', args || undefined)
}

async function queue(_args: string, client: Client): Promise<void> {
	await client.command('queue')
}

async function handoff(args: string, client: Client): Promise<void> {
	await client.command('handoff', args || undefined)
	client.log('local.queue', 'handoff')
}

async function cd(args: string, client: Client): Promise<void> {
	await client.command('cd', args)
	client.log('local.queue', args ? `cd: ${args}` : 'cd')
}

async function reset(args: string, client: Client): Promise<void> {
	if (args) {
		client.log('local.usage', 'usage: /reset')
		return
	}
	await client.command('reset')
	client.log('local.queue', 'reset')
}

async function close(_args: string, client: Client): Promise<void> {
	await client.closeTab()
}

async function clear(_args: string, client: Client): Promise<void> {
	client.clear()
}

async function todo(args: string, client: Client): Promise<void> {
	if (!args) {
		client.log('local.usage', 'usage: /todo <task description>')
		return
	}
	await client.command('prompt', `[todo] ${args}`)
}

async function restart(_args: string, client: Client): Promise<void> {
	await client.command('restart')
	client.log('local.queue', 'restart')
}

async function snapshot(_args: string, client: Client): Promise<void> {
	const terminal = client.getTranscript()
	logSnapshot(terminal)
	const path = getDebugLogPath()
	client.log('local.status', `[snapshot] terminal captured → ${path}`)
}

async function bug(args: string, client: Client): Promise<void> {
	if (!args) {
		client.log('local.usage', 'usage: /bug <description of what went wrong>')
		return
	}
	const terminal = client.getTranscript()
	const bugPath = await saveBugReport(args, terminal)
	if (!bugPath) {
		client.log(
			'local.warn',
			'[bug] debug logging not active — enable config.debug.recordEverything',
		)
		return
	}
	client.log('local.status', `[bug] saved → ${bugPath}`)
	// Send to model so it can investigate
	await client.command(
		'prompt',
		`[bug] ${args}\n\nFix it. If you need the keyboard transcript or full context, the debug log is here: ${bugPath}`,
	)
}

async function fork(_args: string, client: Client): Promise<void> {
	await client.command('fork')
	client.log('local.queue', 'fork')
}

interface RestorableSession {
	id: string
	meta: SessionMeta
}

// Remembered from last /restore listing
let lastRestoreList: RestorableSession[] = []

async function listClosedSessions(activeIds: Set<string>): Promise<RestorableSession[]> {
	if (!existsSync(SESSIONS_DIR)) return []
	const entries = await readdir(SESSIONS_DIR, { withFileTypes: true })
	const results: RestorableSession[] = []

	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith('s-')) continue
		if (activeIds.has(entry.name)) continue
		const meta = await loadSessionInfo(entry.name)
		if (!meta) continue
		results.push({ id: entry.name, meta })
	}

	results.sort((a, b) => new Date(b.meta.updatedAt).getTime() - new Date(a.meta.updatedAt).getTime())
	return results.slice(0, 8)
}

async function restore(args: string, client: Client): Promise<void> {
	const arg = args.trim()

	if (!arg) {
		const activeIds = new Set(client.getActiveSessionIds())
		const sessions = await listClosedSessions(activeIds)
		if (sessions.length === 0) {
			client.log('local.status', '[restore] no closed sessions found')
			return
		}
		lastRestoreList = sessions
		const lines = sessions.map((s, i) => {
			const num = `${i + 1}.`
			const age = timeSince(s.meta.updatedAt)
			const model = s.meta.model ? `  ${s.meta.model}` : ''
			const preview = s.meta.lastPrompt ? ` — ${s.meta.lastPrompt}` : ''
			return `  ${num} ${s.id}  ${age}${model}${preview}`
		})
		client.log('local.status', `[restore] closed sessions:\n${lines.join('\n')}\n  /restore <number> or /restore <session-id>`)
		return
	}

	// Resolve arg to a session
	const num = parseInt(arg, 10)
	let target: RestorableSession | undefined
	if (!isNaN(num) && num >= 1 && num <= lastRestoreList.length) {
		target = lastRestoreList[num - 1]
	} else {
		const id = arg.startsWith('s-') ? arg : `s-${arg}`
		target = lastRestoreList.find((s) => s.id === id)
		if (!target) {
			const meta = await loadSessionInfo(id)
			if (meta) target = { id, meta }
		}
	}

	if (!target) {
		client.log('local.warn', `[restore] session not found: ${arg}`)
		return
	}

	await client.openSession(target.id, target.meta.workingDir)
}


async function topic(args: string, client: Client): Promise<void> {
	if (!args) {
		client.log('local.usage', 'usage: /topic <conversation topic>')
		return
	}
	await client.command('topic', args)
}

function exit(_args: string, _client: Client): void {}

const COMMANDS: Record<string, Handler> = {
	help,
	model,
	system,
	pause,
	drop,
	queue,
	handoff,
	cd,
	close,
	reset,
	clear,
	todo,
	restart,
	snapshot,
	bug,
	fork,
	restore,
	topic,
	exit,
}


const ALIASES: Record<string, string> = {
	bye: 'exit',
	quit: 'exit',
	q: 'exit',
}

export const COMMAND_NAMES = Object.keys(COMMANDS)

export function isExit(normalized: string): boolean {
	if (!normalized.startsWith('/')) return false
	const name = normalized.slice(1).split(' ')[0]
	return (ALIASES[name] ?? name) === 'exit'
}

export async function handleCommand(input: string, client: Client): Promise<void> {
	const trimmed = input.trim()
	if (!trimmed.startsWith('/')) {
		await client.command('prompt', input)
		return
	}

	const spaceIndex = trimmed.indexOf(' ')
	const name = spaceIndex < 0 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)
	const args = spaceIndex < 0 ? '' : trimmed.slice(spaceIndex + 1).trim()

	const resolved = ALIASES[name] ?? name
	const handler = COMMANDS[resolved]
	if (!handler) {
		client.log('local.warn', `unknown command: /${name}`)
		return
	}

	await handler(args, client)
}
