// The host user's home directory, which the host sends each client on
// connect, so shown paths read ~/… instead of /root/… (task xxr).
// Display only: tool inputs and history keep the real path.

let state = { path: undefined as string | undefined }

// `text` with each path under the home written from ~.
function short(text: string): string {
	let h = home.state.path?.replace(/\/+$/, '')
	if (!h) return text
	let escaped = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	return text.replace(new RegExp(`(?<![\\w.~/-])${escaped}(?=/|$|[^\\w.-])`, 'g'), '~')
}

export const home = { state, short }
