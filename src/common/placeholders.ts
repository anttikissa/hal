// Dim example requests shown in an empty prompt, so a new user has
// something concrete to try. They rotate per turn, so each reply
// reveals another idea; the Hal repo has its own list.

const general = [
	'Analyze the project in this directory',
	'What tools do you have available?',
	'Explain the git history of the last week',
	'Find and fix the flakiest test',
	'What would you refactor first here, and why?',
	'Write a README for this project',
]

const hal = [
	'Add one second precision to message timestamps',
	"Make the tab bar show each session's model",
	'Which module is closest to the 400-line limit?',
	'Add a /uptime command that shows when the host process started',
	'What tools do you have available?',
	'Explain the git history of the last week',
]

// The example for `turn`; `hal`: in the Hal repo (the host tells, Tab).
function pick(hal: boolean, turn: number): string {
	let list = hal ? placeholders.hal : placeholders.general
	return list[turn % list.length]!
}

// A rotating example (a form field's placeholder list) `ms` after it
// appeared: hold one, erase it a grapheme at a time, type the next, in
// list order, round and round. A long one (over 50 graphemes) holds
// longer, so there is time to read it. `next`: ms until the text
// changes.
const HOLD = 3000
const LONG_HOLD = 4500
const ERASE = 5
const TYPE = 35 / 3
function rotate(list: string[], ms: number): { text: string; next: number } {
	let graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].map((g) => g.segment)
	if (list.length < 2) return { text: list[0] ?? '', next: Infinity }
	for (let i = 0; ; i = (i + 1) % list.length) {
		let shown = graphemes(list[i]!)
		let coming = graphemes(list[(i + 1) % list.length]!)
		let hold = shown.length > 50 ? LONG_HOLD : HOLD
		let erase = shown.length * ERASE
		if (ms < hold) return { text: shown.join(''), next: hold - ms }
		ms -= hold
		if (ms < erase) return { text: shown.slice(0, shown.length - Math.floor(ms / ERASE) - 1).join(''), next: ERASE - (ms % ERASE) }
		ms -= erase
		if (ms < coming.length * TYPE) return { text: coming.slice(0, Math.floor(ms / TYPE) + 1).join(''), next: TYPE - (ms % TYPE) }
		ms -= coming.length * TYPE
	}
}

export const placeholders = { general, hal, pick, rotate }
