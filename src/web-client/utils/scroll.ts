function toBottom(element: HTMLElement): void {
	element.scrollTop = element.scrollHeight
}

function isNearBottom(element: HTMLElement): boolean {
	return element.scrollHeight - element.clientHeight - element.scrollTop < 25
}

export const webScroll = { toBottom, isNearBottom }
