// iOS Safari does not implement `interactive-widget=resizes-content` (WebKit bug
// 259770): when the on-screen keyboard opens it shrinks and scrolls the *visual*
// viewport while the layout viewport, and therefore 100dvh, stays full height.
// The app box then hangs off the top of the screen and the tab strip is invisible.
// So we mirror the visual viewport into custom properties and size #app from those.
// Chrome and Firefox honour the meta tag, but the same numbers are correct there.

type VisualViewportBox = {
	height: number
	offsetTop: number
}

type VisualViewportSource = VisualViewportBox & {
	addEventListener: (type: string, listener: () => void) => void
}

function cssValues(box: VisualViewportBox): Record<string, string> {
	// offsetTop is how far Safari has scrolled the visual viewport down the layout
	// viewport; translating #app down by it puts the tab strip back on screen.
	return { '--app-height': `${box.height}px`, '--app-top': `${box.offsetTop}px` }
}

function sync(viewport: VisualViewportSource | undefined, style: Pick<CSSStyleDeclaration, 'setProperty'>): void {
	// Without visualViewport we write nothing, leaving the CSS dvh fallback in place.
	if (!viewport) return
	function write(): void {
		for (const [property, value] of Object.entries(cssValues(viewport as VisualViewportBox))) style.setProperty(property, value)
	}
	write()
	// Safari reports the keyboard through both events: resize for the size change
	// and scroll for the offset as it settles.
	viewport.addEventListener('resize', write)
	viewport.addEventListener('scroll', write)
}

export const webViewport = { cssValues, sync }
