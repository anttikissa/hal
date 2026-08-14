function toBottom(): void {
	window.scrollTo({ top: document.documentElement.scrollHeight })
}

function isNearBottom(): boolean {
	return document.documentElement.scrollHeight - window.innerHeight - window.scrollY < 25
}

export const webScroll = { toBottom, isNearBottom }
