import type { ToolCallBlock, ToolResultBlock } from '../common/blocks.ts'
import { toolPresentation, type ToolPresentation } from '../common/tool-presentation.ts'
import { ason } from '../common/ason.ts'

function present(_call: ToolCallBlock, _result?: ToolResultBlock): ToolPresentation | undefined { return undefined }

function attach<T extends ToolCallBlock | ToolResultBlock>(call: ToolCallBlock, target: T): T {
	let presentation: ToolPresentation | undefined
	try {
		presentation = toolPresentations.present(call, target.type === 'tool_result' ? target : undefined)
		if (presentation !== undefined) {
			toolPresentation.check(presentation, target.type === 'tool_result' ? target.output : '')
			return { ...target, presentation }
		}
	} catch (error) {
		return { ...target, presentationError: `Tool presentation failed for ${call.name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\nInput: ${ason.stringify(call.input, 'short')}${presentation === undefined ? '' : `\nPresentation: ${Bun.inspect(presentation, { depth: Infinity, colors: false })}`}` }
	}
	return target
}

export const toolPresentations = { present, attach }
