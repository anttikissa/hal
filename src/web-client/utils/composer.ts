type EnterAction = 'submit' | 'newline' | 'none'

// Desktop chat convention: Enter sends, Shift+Enter inserts a newline. On touch
// keyboards (coarse pointer) there is no Shift, so Enter inserts a newline and
// the Send button sends — the iMessage/WhatsApp pattern.
function enterAction(key: string, opts: { shift?: boolean; coarse?: boolean }): EnterAction {
	if (key !== 'Enter') return 'none'
	if (opts.shift || opts.coarse) return 'newline'
	return 'submit'
}

// While a turn runs, sending interrupts it — the terminal calls that steering.
// Naming the button for what it does keeps the queue button's purpose obvious.
function sendLabel(working: boolean): string {
	return working ? 'Steer' : 'Send'
}

function pastedImage<T extends { type: string }>(items: Iterable<{ type: string; getAsFile: () => T | null }>): T | null {
	for (const item of items) {
		if (!item.type.startsWith('image/')) continue
		const file = item.getAsFile()
		if (file) return file
	}
	return null
}

export { enterAction, pastedImage, sendLabel }
export type { EnterAction }
