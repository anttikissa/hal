type Action = 'open' | 'resume' | 'fork' | 'close' | 'next' | 'prev' | 'run-next-from-queue' | 'abort' | number

function action(event: KeyboardEvent): Action | null {
	if (event.isComposing || event.metaKey) return null
	if (event.altKey && !event.ctrlKey && !event.shiftKey) {
		const digit = /^Digit([0-9])$/.exec(event.code)?.[1]
		if (digit !== undefined) return digit === '0' ? 10 : Number(digit)
	}
	if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey) return 'abort'
	if (!event.ctrlKey || event.altKey) return null
	switch (event.key.toLowerCase()) {
		case 't': return event.shiftKey ? 'resume' : 'open'
		case 'f': return 'fork'
		case 'n': return 'next'
		case 'p': return 'prev'
		case 'w': return 'close'
		case 'q': return 'run-next-from-queue'
	}
	return null
}

export const webShortcuts = { action }
