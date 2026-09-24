function toBottom(element: HTMLElement, gap = 0): void {
	element.scrollTop = element.scrollHeight - element.clientHeight - gap
}

function bottomGap(element: HTMLElement): number | null {
	const gap = Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop)
	return gap < 50 ? gap : null
}

export const webScroll = { toBottom, bottomGap }
