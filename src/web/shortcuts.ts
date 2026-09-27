// Tab keys in the browser, where it lets the page have them: Alt-1..9
// show that tab and Alt-0 the tenth (matched by physical key, since
// Alt types symbols on macOS); on macOS also Ctrl-T new, Ctrl-W close,
// Ctrl-N next and Ctrl-P previous. Other systems' browsers keep
// Ctrl-T/W/N, so there the buttons do it.

export type TabAction = { type: 'new' } | { type: 'close' } | { type: 'next' } | { type: 'prev' } | { type: 'go'; index: number }

export type TabKey = { key: string; code?: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing?: boolean }

const ctrlKeys: Record<string, TabAction> = { t: { type: 'new' }, w: { type: 'close' }, n: { type: 'next' }, p: { type: 'prev' } }

function action(e: TabKey, mac: boolean): TabAction | undefined {
	if (e.isComposing || e.metaKey || e.shiftKey) return undefined
	if (e.altKey && !e.ctrlKey) {
		let digit = /^Digit([0-9])$/.exec(e.code ?? '')?.[1]
		return digit === undefined ? undefined : { type: 'go', index: digit === '0' ? 9 : Number(digit) - 1 }
	}
	if (!mac || !e.ctrlKey || e.altKey) return undefined
	return ctrlKeys[e.key.toLowerCase()]
}

export const shortcuts = { action }
