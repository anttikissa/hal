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

export const placeholders = { general, hal, pick }
