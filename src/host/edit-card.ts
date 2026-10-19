// EDIT cards retain their description and show the versioned result once.
import { diff } from '../common/diff.ts'
import type { ToolCallBlock, ToolResultBlock } from '../common/blocks.ts'
import type { ToolPresentation } from '../common/tool-presentation.ts'

function present(call: ToolCallBlock, result?: ToolResultBlock): ToolPresentation | undefined {
	if (!Array.isArray(call.input.edits)) return undefined
	const names = [...new Set<string>(call.input.edits.flatMap((e) => (typeof e?.path === 'string' ? [e.path] : [])))]
	const description = typeof call.input.description === 'string' ? call.input.description.trim() : ''
	const counts = result && !result.isError ? diff.stats(result.output) : undefined
	const suffix = counts ? `${counts.added ? `+${counts.added}` : ''}${counts.removed ? `-${counts.removed}` : ''}` : ''
	return {
		title: `> ${description || names.join(', ') + (suffix ? ` ${suffix}` : '') || 'files'}`,
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
