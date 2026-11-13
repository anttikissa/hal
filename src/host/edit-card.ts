// Shows EDIT calls as readable cards: the title names the files and the
// call's description (tool-details.ts), and the versioned result shows once.
import type { ToolCallBlock, ToolResultBlock } from '../common/blocks.ts'
import { toolDetails } from '../common/tool-details.ts'
import type { ToolPresentation } from '../common/tool-presentation.ts'

function present(call: ToolCallBlock, result?: ToolResultBlock): ToolPresentation | undefined {
	if (!Array.isArray(call.input.edits)) return undefined
	return {
		title: toolDetails.headline('edit', call.input).text,
		blocks: !result
			? []
			: result.isError
				? call.cmd
					? [{ kind: 'code', text: call.cmd }]
					: []
				: [{ kind: 'diff', text: { from: 0, to: result.output.length } }],
	}
}

export const editCard = { present }
