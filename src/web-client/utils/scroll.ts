function toBottom(element: HTMLElement, gap = 0, smooth = false): void {
	const top = element.scrollHeight - element.clientHeight - gap
	if (smooth) element.scrollTo({ top, behavior: 'smooth' })
	else element.scrollTop = top
}

function bottomGap(element: HTMLElement): number | null {
	const gap = Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop)
	return gap < 50 ? gap : null
}

function keepBottom(element: HTMLElement, change: () => void): void {
	const gap = webScroll.bottomGap(element)
	change()
	if (gap !== null) webScroll.toBottom(element, gap)
}

export const webScroll = { toBottom, bottomGap, keepBottom }
