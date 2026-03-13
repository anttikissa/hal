import { readFiles } from '../utils/read-file.ts'
import { formatContext, parseRef, resolvePath, validateRef, withLock } from './file-utils.ts'
import { defineTool, previewField, type ToolContext } from './tool.ts'

interface EditApplyResult {
	result: string
	resultLines: string[]
}

const definition = {
	name: 'edit',
	description: `Edit a file using hashline refs from read. Hashes are verified; mismatch = re-read needed.
- replace: replace start_ref..end_ref (inclusive) with new_content. Same ref for single line. Empty new_content to delete.
- insert: insert new_content after after_ref. Use "0:000" for beginning of file.
new_content is raw file content — no hashline prefixes. A trailing newline in new_content is stripped (each line in the file already has one).`,
	input_schema: {
		type: 'object',
		properties: {
			path: { type: 'string' },
			operation: { type: 'string', enum: ['replace', 'insert'] },
			start_ref: { type: 'string', description: 'LINE:HASH of first line to replace' },
			end_ref: { type: 'string', description: 'LINE:HASH of last line to replace' },
			after_ref: { type: 'string', description: "LINE:HASH to insert after (or '0:000' for start)" },
			new_content: { type: 'string', description: 'Replacement text (raw, no hashline prefixes)' },
		},
		required: ['path', 'operation', 'new_content'],
	},
	cache_control: { type: 'ephemeral' },
}

function applyReplace(content: string, startRef: string, endRef: string, newContent: string, contextLines: number): EditApplyResult | string {
	const start = parseRef(startRef)
	const end = parseRef(endRef)
	if (!start) return `error: invalid start ref: ${startRef}`
	if (!end) return `error: invalid end ref: ${endRef}`

	const lines = content.split('\n')
	const startError = validateRef(start, lines)
	const endError = validateRef(end, lines)
	if (startError) return `error: ${startError}\n\nRe-read the file to get updated LINE:HASH references.`
	if (endError) return `error: ${endError}\n\nRe-read the file to get updated LINE:HASH references.`
	if (start.line > end.line) return `error: start ${start.line} > end ${end.line}`

	const before = formatContext(lines, start.line - 1, end.line, contextLines)
	const normalizedNewContent = newContent.replace(/\n$/, '')
	const newLines = normalizedNewContent === '' ? [] : normalizedNewContent.split('\n')
	const resultLines = [...lines.slice(0, start.line - 1), ...newLines, ...lines.slice(end.line)]
	const after = formatContext(resultLines, start.line - 1, start.line - 1 + newLines.length, contextLines)
	return { result: `--- before\n${before}\n\n+++ after\n${after}`, resultLines }
}

function applyInsert(content: string, afterRef: string, newContent: string, contextLines: number): EditApplyResult | string {
	const lines = content.split('\n')
	const normalizedNewContent = newContent.replace(/\n$/, '')
	const newLines = normalizedNewContent.split('\n')

	let insertAt: number
	if (afterRef === '0:000') {
		insertAt = 0
	} else {
		const ref = parseRef(afterRef)
		if (!ref) return `error: invalid ref: ${afterRef}`
		const error = validateRef(ref, lines)
		if (error) return `error: ${error}\n\nRe-read the file to get updated LINE:HASH references.`
		insertAt = ref.line
	}

	const before = formatContext(lines, insertAt, insertAt, contextLines)
	const resultLines = [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)]
	const after = formatContext(resultLines, insertAt, insertAt + newLines.length, contextLines)
	return { result: `--- before\n${before}\n\n+++ after\n${after}`, resultLines }
}

async function execute(input: unknown, ctx: ToolContext): Promise<string> {
	const inp = input as any
	const path = resolvePath(inp?.path, ctx.cwd)
	if (inp?.operation !== 'replace' && inp?.operation !== 'insert') return `error: unknown operation "${inp?.operation}"`

	return withLock(path, async () => {
		const content = readFiles.readTextSync(path, 'tool.edit')
		const newContent = String(inp?.new_content ?? '')
		const contextLines = ctx.contextLines ?? 3

		let applied: EditApplyResult | string
		if (inp.operation === 'replace') {
			if (!inp?.start_ref || !inp?.end_ref) return 'error: replace requires start_ref and end_ref'
			applied = applyReplace(content, inp.start_ref, inp.end_ref, newContent, contextLines)
		} else {
			if (!inp?.after_ref) return 'error: insert requires after_ref'
			applied = applyInsert(content, inp.after_ref, newContent, contextLines)
		}

		if (typeof applied === 'string') return applied
		await Bun.write(path, applied.resultLines.join('\n'))
		return applied.result
	})
}

export const edit = defineTool({
	definition,
	argsPreview: previewField('path'),
	execute,
})
