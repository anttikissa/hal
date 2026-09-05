import { webDraft } from './draft.ts'

function isInstalled(
	navigator: { standalone?: boolean } = window.navigator as Navigator & { standalone?: boolean },
	matchMedia: (query: string) => { matches: boolean } = window.matchMedia.bind(window),
): boolean {
	// iOS exposes the legacy flag; Android and modern browsers use display-mode.
	return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches
}

function reload(): void {
	window.location.reload()
}

function refresh(): boolean {
	// Every input is saved synchronously; retry any failed writes before navigating.
	if (!webDraft.flush()) return false
	appActions.reload()
	return true
}

export const appActions = { isInstalled, reload, refresh }
