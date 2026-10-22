// Plugin tools get a good card without writing a presentation (task
// m3a): the title says why the call ran, the second row shows the raw
// command as code, then the result in full, colored by the tool's kind
// or hue. Tools in src/host/tools/ keep their own rendering.
import { existsSync } from 'fs'
import type { ToolCallBlock, ToolResultBlock } from '../common/blocks.ts'
import { callText } from '../common/call-text.ts'
import type { PresentationBlock, ToolPresentation } from '../common/tool-presentation.ts'
import { toolDetails } from '../common/tool-details.ts'
import { tools, type Tool } from './tools.ts'

// The call's purpose: its /* comment */ or description field.
function purpose(call: ToolCallBlock): string | undefined {
	let said = typeof call.input.description === 'string' ? call.input.description : undefined
	if (!said && call.cmd !== undefined)
		try {
			let parsed = callText.parse(call.cmd)
			said = callText.values(parsed.raw).purpose ?? parsed.purpose
		} catch {}
	return said?.replace(/\s+/g, ' ').trim() || undefined
}

// read_url → 'Read url'.
function name(tool: Tool<unknown>): string {
	return (tool.name.charAt(0).toUpperCase() + tool.name.slice(1)).replaceAll('_', ' ')
}

// The call's arguments: the raw command as code, then the others as
// readable "key: value" text.
function args(tool: Tool<unknown>, input: Record<string, unknown>): PresentationBlock[] {
	let field = tool.card?.command
	let command = field !== undefined && typeof input[field] === 'string' ? (input[field] as string) : undefined
	let rest = Object.fromEntries(
		Object.entries(input).filter(([k]) => k !== 'description' && (command === undefined || k !== field)),
	)
	return [
		...(command === undefined
			? []
			: [{ kind: 'code' as const, text: command, ...(tool.card?.language && { language: tool.card.language }) }]),
		...(Object.keys(rest).length ? [{ kind: 'text' as const, text: toolDetails.value(rest).join('\n') }] : []),
	]
}

// Plugin tools have cards; built-in ones only when they declare one.
function has(tool: Tool<unknown>): boolean {
	return !!tool.card || !existsSync(`${tools.dir()}/${tool.name}.ts`)
}

function present(call: ToolCallBlock, result?: ToolResultBlock): ToolPresentation | undefined {
	let tool = tools.all().find((t) => t.name === call.name)
	if (!tool || !toolCard.has(tool)) return undefined
	let blocks = args(tool, call.input)
	// A failure shows complete, once, under these blocks.
	if (result?.output && !result.isError) blocks.push({ kind: 'text', text: { from: 0, to: result.output.length } })
	return {
		title: purpose(call) || tool.card?.title?.(call.input, result)?.trim() || name(tool),
		blocks,
		readOnly: tool.readOnly === true,
		icon: tool.card?.icon ?? 'sparkle',
		...(tool.card?.hue !== undefined && { hue: tool.card.hue }),
	}
}

export const toolCard = { has, present }
