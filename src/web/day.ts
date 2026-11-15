// Re-dates block header times when the local day changes, so blocks
// from yesterday say so while the page stays open (task hp). Every
// titles.time read in a reactive scope tracks the day.
import { createSignal } from 'solid-js'
import { titles } from '../common/titles.ts'

function install(): void {
	let [day, setDay] = createSignal(0)
	titles.track = day
	let check = () => {
		if (!titles.stale()) return
		titles.forgetTimes()
		setDay((n) => n + 1)
	}
	// A minute's check also catches a midnight slept through.
	setInterval(check, 60_000)
	document.addEventListener('visibilitychange', check)
}

export const day = { install }
