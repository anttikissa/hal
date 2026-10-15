// EDIT cards (tasks ybg, sn7): the files with change counts, then the
// verified diffs; a failed edit shows the call as the model sent it.
import { diff } from '../common/diff.ts'
import type { ToolCallBlock, ToolResultBlock } from '../common/blocks.ts'
import type { ToolPresentation } from '../common/tool-presentation.ts'

function present(call: ToolCallBlock, result?: ToolResultBlock): ToolPresentation | undefined {
	if (!Array.isArray(call.input.edits)) return undefined
	const edits = call.input.edits
	const countsByPath = new Map<string, number>()
	for (const e of edits) if (e && typeof e.path === 'string') countsByPath.set(e.path, (countsByPath.get(e.path) ?? 0) + 1)
	const names = [...countsByPath.keys()]
	const created = new Set(edits.filter((e) => e?.create === true).map((e) => e.path))
	const label = names.length ? names.map((p) => created.has(p) ? `+${p}` : p).join(', ') : 'files'
	const requested = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'} requested`
	if (!result) return {
		title: `> ${label}`,
		blocks: names.map((path) => ({ kind: 'text', path, text: requested(countsByPath.get(path)!) }))
	}
	// Nothing was written: show the call as the model sent it.
	if (result.isError) return {
		title: `> ${label}`,
		blocks: call.cmd ? [{ kind: 'code', text: call.cmd }] : names.map((path) => ({ kind: 'text', path, text: requested(countsByPath.get(path)!) }))
	}
	const headers = [...result.output.matchAll(/^== (.+?)(@[a-z0-9]+| deleted) verified ==\n/gm)]
	if (!headers.length || result.output.includes('[cut:')) return {
		title: `> ${label}`,
		blocks: [...names.map((path) => ({ kind: 'text' as const, path, text: 'Requested edit' })), {
			kind: 'text',
			text: { from: 0, to: result.output.length }
		}]
	}
	const tail = result.output.indexOf('\n== then '), end = tail < 0 ? result.output.length : tail
	const named = (path: string) => names.find((p) => path === p || path.endsWith(`/${p.replace(/^\.\//, '')}`)) ?? path
	const divider = '\n== diff ==\n'
	const blocks = headers.map((m, i) => {
		const from = m.index! + m[0].length, to = headers[i + 1]?.index ?? end
		const at = result.output.indexOf(divider, from - 1)
		return {
			kind: 'diff' as const,
			path: named(m[1]!),
			text: { from: at >= from - 1 && at < to ? at + divider.length : from, to }
		}
	})
	// foo.ts +2-2, +new.ts +110, -old.ts, named as the call named them.
	const files = headers.map((m, i) => {
		const path = named(m[1]!)
		if (m[2] === ' deleted') return `-${path}`
		const s = diff.stats(result.output.slice(blocks[i]!.text.from, blocks[i]!.text.to))
		const counts = `${s.added ? `+${s.added}` : ''}${s.removed ? `-${s.removed}` : ''}`
		return `${created.has(path) ? '+' : ''}${path}${counts ? ` ${counts}` : ''}`
	})
	return {
		title: `> ${files.join(', ')}`,
		blocks: [...blocks.flatMap((block, i) => block.text.from > headers[i]!.index! + headers[i]![0].length
			? [{ kind: 'text' as const, text: { from: headers[i]!.index!, to: block.text.from - divider.length } }, block]
			: [block]), ...(tail < 0 ? [] : [{
			kind: 'text' as const,
			text: { from: tail + 1, to: result.output.length }
		}])]
	}
}

export const editCard = { present }
