export type PresentationBlock = { kind: 'text' | 'code' | 'diff'; path?: string; language?: string; text: string | { from: number; to: number } }
export type ToolPresentation = { title: string; blocks: PresentationBlock[] }

function check(value: unknown, output = ''): void {
	let p = value as ToolPresentation
	if (!p || typeof p !== 'object' || typeof p.title !== 'string' || !p.title.trim() || !Array.isArray(p.blocks)) throw new Error('Invalid tool presentation: expected title and blocks')
	for (let b of p.blocks) {
		if (!b || !['text', 'code', 'diff'].includes(b.kind) || (b.path !== undefined && typeof b.path !== 'string') || (b.language !== undefined && typeof b.language !== 'string')) throw new Error('Invalid tool presentation block')
		if (typeof b.text === 'string') continue
		let r = b.text
		if (!r || !Number.isSafeInteger(r.from) || !Number.isSafeInteger(r.to) || r.from < 0 || r.to < r.from || r.to > output.length) throw new Error('Invalid tool presentation output range')
	}
}

function text(block: PresentationBlock, output = ''): string {
	return typeof block.text === 'string' ? block.text : output.slice(block.text.from, block.text.to)
}

export const toolPresentation = { check, text }
