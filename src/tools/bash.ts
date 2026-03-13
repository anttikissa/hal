import { defineTool, previewField, type ToolChunkHandler } from './tool.ts'

export const bashConfig = {
	inlineHeaderMax: 60,
}

export type BashStatus = 'streaming' | 'running' | 'done' | 'error'

export interface BashExecuteContext {
	cwd: string
	env?: Record<string, string | undefined>
	signal?: AbortSignal
}

export interface BashFormatBlockInput {
	command: string
	status: BashStatus
	elapsed: string
	output: string
	commandWidth: number
	maxOutputLines: number
	inlineHeaderMax?: number
}

export interface BashFormatBlock {
	label: string
	commandLines: string[]
	outputLines: string[]
	hiddenOutputLines: number
}

const definition = {
	name: 'bash',
	description: 'Run a bash command',
	input_schema: {
		type: 'object',
		properties: { command: { type: 'string' } },
		required: ['command'],
	},
}

const commandPreview = previewField('command')

function statusIcon(status: BashStatus): string {
	switch (status) {
		case 'done':
			return '✓'
		case 'error':
			return '✗'
		default:
			return '…'
	}
}

function wrapCommand(command: string, width: number): string[] {
	const max = Math.max(1, width)
	if (command.length <= max) return [command]
	const out: string[] = []
	let rest = command
	const suffix = ' \\'
	const take = Math.max(1, max - suffix.length)
	while (rest.length > max) {
		out.push(rest.slice(0, take) + suffix)
		rest = rest.slice(take)
	}
	out.push(rest)
	return out
}

function formatOutput(output: string, maxOutputLines: number): { outputLines: string[]; hiddenOutputLines: number } {
	const outputText = output.trimEnd()
	if (!outputText) return { outputLines: [], hiddenOutputLines: 0 }
	const lines = outputText.split('\n').map((line) => line.replace(/\r/g, ''))
	if (lines.length <= maxOutputLines) return { outputLines: lines, hiddenOutputLines: 0 }
	const hiddenOutputLines = lines.length - maxOutputLines
	return { outputLines: lines.slice(-maxOutputLines), hiddenOutputLines }
}

function formatBlock(input: BashFormatBlockInput): BashFormatBlock {
	const command = input.command
	const inlineHeaderMax = input.inlineHeaderMax ?? bashConfig.inlineHeaderMax
	let label = ''
	let commandLines: string[] = []
	if (command.length > inlineHeaderMax) {
		label = `bash: (${input.elapsed}) ${statusIcon(input.status)}`
		commandLines = wrapCommand(command, input.commandWidth)
	} else {
		label = `bash: ${command} (${input.elapsed}) ${statusIcon(input.status)}`
	}
	const { outputLines, hiddenOutputLines } = formatOutput(input.output, input.maxOutputLines)
	return { label, commandLines, outputLines, hiddenOutputLines }
}

function childPids(parentPid: number): number[] {
	const result = Bun.spawnSync(['pgrep', '-P', String(parentPid)], {
		stdout: 'pipe',
		stderr: 'ignore',
	})
	if (result.exitCode !== 0) return []
	const text = new TextDecoder().decode(result.stdout).trim()
	if (!text) return []
	return text.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0)
}

function killProcessTree(rootPid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
	for (const pid of childPids(rootPid)) killProcessTree(pid, signal)
	try { process.kill(rootPid, signal) } catch {}
}

async function execute(input: unknown, ctx: BashExecuteContext, onChunk?: ToolChunkHandler): Promise<string> {
	const cmd = commandPreview(input)
	const proc = Bun.spawn(['bash', '-lc', cmd], {
		cwd: ctx.cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, ...ctx.env, TERM: 'dumb' },
	})

	// Kill full process tree on abort (SIGTERM, then SIGKILL after 2s)
	if (ctx.signal) {
		const onAbort = () => {
			killProcessTree(proc.pid, 'SIGTERM')
			const timer = setTimeout(() => killProcessTree(proc.pid, 'SIGKILL'), 2000)
			;(timer as any).unref?.()
		}
		if (ctx.signal.aborted) onAbort()
		else ctx.signal.addEventListener('abort', onAbort, { once: true })
	}

	let out = ''
	const reader = proc.stdout.getReader()
	const decoder = new TextDecoder()
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		const chunk = decoder.decode(value, { stream: true })
		out += chunk
		if (onChunk) await onChunk(chunk)
	}
	const stderr = await new Response(proc.stderr).text()
	const code = await proc.exited
	if (ctx.signal?.aborted) return out + (stderr ? '\n' + stderr : '') + '\n[interrupted]'
	if (stderr) out += (out ? '\n' : '') + stderr
	if (code !== 0) out += `\n[exit ${code}]`
	return out || '(no output)'
}

export const bash = Object.assign(
	defineTool<BashExecuteContext, string>({
		definition,
		argsPreview: commandPreview,
		execute,
	}),
	{ config: bashConfig, formatBlock, killProcessTree },
)
