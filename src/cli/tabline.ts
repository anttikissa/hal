export interface TablineTab {
	label: string
	busy: boolean
	active: boolean
}

function compactLabel(label: string): string {
	const m = label.match(/^(\d+)/)
	if (m) return m[1]
	return label.trim()[0] ?? label
}

function mode1(tabs: TablineTab[]): string[] {
	return tabs.map((t) => {
		const core = compactLabel(t.label)
		const busy = t.busy ? 'x' : ' '
		return `[${core}${busy}] `
	})
}

function mode2(tabs: TablineTab[]): string[] {
	return tabs.map((t) => {
		const core = compactLabel(t.label)
		return `${core}${t.busy ? 'x' : ''} `
	})
}

function mode3(tabs: TablineTab[]): string[] {
	return tabs.map((t) => compactLabel(t.label))
}

function fit(parts: string[], width: number): string {
	let out = ''
	for (const p of parts) {
		if ((out + p).length > width) break
		out += p
	}
	return out
}

export function renderTabline(tabs: TablineTab[], width: number): string {
	if (width <= 0) return ''

	const full = tabs.map((t) => (t.active ? `[${t.label}]` : ` ${t.label} `))
	let line = fit(full, width)
	if (line.length === full.join('').length) return line

	const a = mode1(tabs)
	line = fit(a, width)
	if (line.length === a.join('').length) return line

	const b = mode2(tabs)
	line = fit(b, width)
	if (line.length === b.join('').length) return line

	const c = mode3(tabs)
	line = fit(c, width)
	if (line.length === c.join('').length) return line

	const flat = c.join('')
	if (flat.length <= width) return flat
	if (width <= 3) return flat.slice(0, width)
	return flat.slice(0, width - 3) + '...'
}
