// A phone transcript needs the result of a tool call, not its entire transport
// payload. These are intentionally the same small facts the terminal surfaces:
// paths, ranges, counts, and at most a few useful output lines.

type ToolLike = {
	name: string
	input?: unknown
	output?: string
	running?: boolean
}

export type ToolCard = {
	title: string
	detail?: string
	preview: string[]
	hiddenLines?: number
}

function objectInput(input: unknown): Record<string, unknown> {
	if (input && typeof input === 'object') return input as Record<string, unknown>
	return {}
}

function text(value: unknown, fallback = '?'): string {
	return typeof value === 'string' && value ? value : fallback
}

function quote(value: unknown): string {
	return `“${text(value).replace(/”/g, '””')}”`
}

function lines(output: string | undefined): string[] {
	if (!output) return []
	return output.trimEnd().split('\n')
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function lineCount(content: unknown, insert = false): number {
	const normalized = String(content ?? '').replace(/\n$/, '')
	if (!normalized && !insert) return 0
	return normalized.split('\n').length
}

function editDetail(input: Record<string, unknown>): string | undefined {
	if (input.operation === 'replace') {
		const start = text(input.start, '')
		const end = text(input.end, start)
		const range = start === end ? start : `${start}...${end}`
		const oldCount = Number(end.split(':')[0]) - Number(start.split(':')[0]) + 1
		const newCount = lineCount(input.new_content)
		if (newCount === 0) return `Delete lines ${range}`
		if (start === end) return `Replace line ${start}`
		const counts = oldCount === newCount ? String(oldCount) : `${oldCount} → ${newCount}`
		return `Replace lines ${range} (${counts} ${newCount === 1 ? 'line' : 'lines'})`
	}
	if (input.operation !== 'insert') return undefined
	const after = text(input.after, '')
	const count = lineCount(input.new_content, true)
	return `Insert ${count} ${count === 1 ? 'line' : 'lines'} ${after === '0:000' ? 'before line 1' : `after ${after}`}`
}

function title(name: string, input: Record<string, unknown>): string {
	if (name === 'bash') {
		const command = text(input.command, '')
		return command && !command.includes('\n') && command.length <= 60 ? `Bash · ${command}` : 'Bash'
	}
	if (name === 'read') {
		const start = input.start ?? input.end
		const range = start === undefined ? '' : ` (${String(input.start ?? 1)}–${String(input.end ?? 'end')})`
		return `Read ${text(input.path)}${range}`
	}
	if (name === 'edit') return `Edit ${text(input.path)}`
	if (name === 'write') return `Write ${text(input.path)}`
	if (name === 'grep') return `Grep ${quote(input.pattern)} in ${text(input.path)}`
	if (name === 'glob') return `Glob ${text(input.pattern)} in ${text(input.path, '.')}`
	if (name === 'google') return `Google ${quote(input.query)}`
	return name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ')
}

function sampled(output: string | undefined, limit: number): Pick<ToolCard, 'preview' | 'hiddenLines'> {
	const all = lines(output)
	const preview = all.slice(0, limit)
	const hiddenLines = all.length - preview.length
	return hiddenLines > 0 ? { preview, hiddenLines } : { preview }
}

function present(tool: ToolLike): ToolCard {
	const input = objectInput(tool.input)
	const card: ToolCard = { title: title(tool.name, input), preview: [] }
	if (tool.running) card.detail = 'Running…'
	if (tool.name === 'read') {
		const all = lines(tool.output)
		if (all.length) card.detail = `${all.length} ${all.length === 1 ? 'line' : 'lines'} · ${formatSize(new TextEncoder().encode(tool.output).byteLength)}`
		return card
	}
	if (tool.name === 'edit') {
		card.detail = editDetail(input) ?? card.detail
		return card
	}
	if (tool.name === 'write') {
		if (!card.detail) card.detail = tool.output?.trim() && tool.output.trim() !== 'ok' ? tool.output.trim() : 'Written'
		return card
	}
	if (tool.name === 'grep' || tool.name === 'glob' || tool.name === 'ls') return { ...card, ...sampled(tool.output, 5) }
	return { ...card, ...sampled(tool.output, 6) }
}

export const toolCard = { present }
