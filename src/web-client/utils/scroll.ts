function toBottom(): void {
	window.scrollTo({ top: document.documentElement.scrollHeight })
}

export const webScroll = { toBottom }
