// Lets a tool show its result as titled text, code and diff blocks
// instead of raw output. A block holds its text or a range of the
// output; check() rejects a malformed presentation.
// The look rides along so history replays it without the plugin (task
// m3a): `hue` colors the card at the shared vivid levels (colors.cardHue),
// else `readOnly` picks the read or side-effect color; `icon` names a
// web icon (web/icons.ts).
export type PresentationBlock = {
	kind: 'text' | 'code' | 'diff'
	path?: string
	language?: string
	text: string | { from: number; to: number }
}
export type ToolPresentation = {
	title: string
	blocks: PresentationBlock[]
	hue?: number
	readOnly?: boolean
	icon?: string
}

function check(value: unknown, output = ''): void {
	let p = value as ToolPresentation
	if (!p || typeof p !== 'object' || typeof p.title !== 'string' || !p.title.trim() || !Array.isArray(p.blocks))
		throw new Error('Invalid tool presentation: expected title and blocks')
	if (p.hue !== undefined && !(Number.isFinite(p.hue) && p.hue >= 0 && p.hue < 360))
		throw new Error(`Invalid tool presentation hue ${p.hue}: expected 0 <= hue < 360`)
	if (p.readOnly !== undefined && typeof p.readOnly !== 'boolean')
		throw new Error('Invalid tool presentation readOnly: expected a boolean')
	if (p.icon !== undefined && typeof p.icon !== 'string')
		throw new Error('Invalid tool presentation icon: expected an icon name')
	for (let b of p.blocks) {
		if (
			!b ||
			!['text', 'code', 'diff'].includes(b.kind) ||
			(b.path !== undefined && typeof b.path !== 'string') ||
			(b.language !== undefined && typeof b.language !== 'string')
		)
			throw new Error('Invalid tool presentation block')
		if (typeof b.text === 'string') continue
		let r = b.text
		if (
			!r ||
			!Number.isSafeInteger(r.from) ||
			!Number.isSafeInteger(r.to) ||
			r.from < 0 ||
			r.to < r.from ||
			r.to > output.length
		)
			throw new Error('Invalid tool presentation output range')
	}
}

function text(block: PresentationBlock, output = ''): string {
	return typeof block.text === 'string' ? block.text : output.slice(block.text.from, block.text.to)
}

// Replaces `old` in `output` with `next`, moving the presentation's
// output ranges with the text so they still cover the same output.
function replace(
	output: string,
	presentation: ToolPresentation | undefined,
	old: string,
	next: string,
): { output: string; presentation?: ToolPresentation } {
	let at = output.indexOf(old)
	if (at < 0) return { output, presentation }
	let move = (p: number) =>
		p <= at ? p : p >= at + old.length ? p + next.length - old.length : Math.min(p, at + next.length)
	return {
		output: output.slice(0, at) + next + output.slice(at + old.length),
		presentation: presentation && {
			...presentation,
			blocks: presentation.blocks.map((b) =>
				typeof b.text === 'string' ? b : { ...b, text: { from: move(b.text.from), to: move(b.text.to) } },
			),
		},
	}
}

export const toolPresentation = { check, text, replace }
