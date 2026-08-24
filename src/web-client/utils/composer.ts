type EnterAction = 'submit' | 'newline' | 'none'

// Desktop chat convention: Enter sends, Shift+Enter inserts a newline. On touch
// keyboards (coarse pointer) there is no Shift, so Enter inserts a newline and
// the Send button sends — the iMessage/WhatsApp pattern.
function enterAction(key: string, opts: { shift?: boolean; coarse?: boolean }): EnterAction {
	if (key !== 'Enter') return 'none'
	if (opts.shift || opts.coarse) return 'newline'
	return 'submit'
}

export { enterAction }
export type { EnterAction }
