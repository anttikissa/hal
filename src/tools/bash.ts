export const bashConfig = {
	inlineHeaderMax: 60,
}

export type BashStatus = 'streaming' | 'running' | 'done' | 'error'

export interface BashExecuteContext {
	cwd: string
	env?: Record<string, string | undefined>
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

type OnChunk = (text: string) => Promise<void>

const definition = {
	name: 'bash',
	description: 'Run a bash command',
	input_schema: {
		type: 'object',
		properties: { command: { type: 'string' } },
		required: ['command'],
	},
}

function argsPreview(input: unknown): string {
	const inp = input as any
	return String(inp?.command ?? '')
}

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

async function execute(input: unknown, ctx: BashExecuteContext, onChunk?: OnChunk): Promise<string> {
	const cmd = argsPreview(input)
	const proc = Bun.spawn(['bash', '-lc', cmd], {
		cwd: ctx.cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, ...ctx.env, TERM: 'dumb' },
	})
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
	if (stderr) out += (out ? '\n' : '') + stderr
	if (code !== 0) out += `\n[exit ${code}]`
	return out || '(no output)'
}

export const bash = { config: bashConfig, definition, argsPreview, formatBlock, execute }
