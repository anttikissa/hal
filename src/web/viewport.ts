// The page fits the visual viewport. iOS Safari ignores
// interactive-widget=resizes-content (WebKit bug 259770): when the
// on-screen keyboard opens it shrinks and pans the visual viewport while
// the layout viewport, and so 100dvh, stays full height, which would
// hide the composer under the keyboard or the tab strip off the top.
// So the visual viewport's height and offset go into CSS custom
// properties (--app-height, --app-top) that size and translate the app;
// without visualViewport the CSS keeps 100dvh. Chrome and Firefox
// honour the meta tag, and the same numbers are right there too.

export type Box = { height: number; offsetTop: number }

type Source = Box & {
	addEventListener: (type: string, listener: () => void) => void
	removeEventListener: (type: string, listener: () => void) => void
}

// offsetTop is how far the browser has panned the visual viewport down
// the layout viewport; translating the app there puts it back on screen.
function css(box: Box): Record<string, string> {
	return { '--app-height': `${box.height}px`, '--app-top': `${box.offsetTop}px` }
}

// Mirrors `source` into `style` now and on every change; answers the
// function that stops.
function sync(source: Source | undefined, style: Pick<CSSStyleDeclaration, 'setProperty'>): () => void {
	if (!source) return () => {}
	let write = () => {
		for (let [k, v] of Object.entries(css(source))) style.setProperty(k, v)
	}
	write()
	// Safari reports the keyboard as a resize, then the offset as it
	// settles as a scroll.
	source.addEventListener('resize', write)
	source.addEventListener('scroll', write)
	return () => {
		source.removeEventListener('resize', write)
		source.removeEventListener('scroll', write)
	}
}

export const viewport = { css, sync }
