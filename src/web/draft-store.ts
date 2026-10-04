import type { Local } from '../common/drafts.ts'

// The browser's local copy of drafts, for typing while disconnected
// and prompts not yet acknowledged when the tab closes.
export const store = {
	load: (id: string): Local | undefined => {
		try {
			return JSON.parse(localStorage.getItem(`hal-draft:${id}`) ?? 'null') ?? undefined
		} catch {
			return undefined
		}
	},
	save: (id: string, local: Local): void => {
		try {
			if (!local.text && !local.sending.length && !local.queueEdit) localStorage.removeItem(`hal-draft:${id}`)
			else localStorage.setItem(`hal-draft:${id}`, JSON.stringify(local))
		} catch {
			// Storage full or disabled: the host still has the draft.
		}
	},
}
