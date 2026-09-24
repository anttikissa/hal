// The server turns colors.ason into CSS at /colors.css. Poll it while the app
// is open so palette edits reach browsers without a refresh or socket message.
const config = { pollMs: 2000 }

async function fetchSource(): Promise<string> {
	const response = await fetch('/colors.css', { cache: 'no-store' })
	if (!response.ok) throw new Error(`Palette unavailable: ${response.status}`)
	return response.text()
}

function pause(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, palette.config.pollMs))
}

async function sync(apply: (css: string) => void, stopped: () => boolean = () => false): Promise<void> {
	let previous: string | null = null
	while (!stopped()) {
		let source: string | null = null
		try {
			source = await palette.fetchSource()
		} catch {
			// A restart can briefly interrupt the request: retain the last palette.
		}
		if (source !== null && source !== previous) {
			previous = source
			apply(source)
		}
		if (!stopped()) await palette.pause()
	}
}

export const palette = { config, fetchSource, pause, sync }
