// Dim example prompts shown in an empty prompt box so a new user has something
// concrete to try. Rotates per turn so each reply reveals another idea.

const general = [
	'Analyze the project in this directory',
	'What tools do you have available?',
	'Explain the git history of the last week',
	'Find and fix the flakiest test',
	'What would you refactor first here, and why?',
	'Write a README for this project',
]

const hal = [
	'Add second precision to message timestamps',
	'Make the tab bar show each session\'s model',
	'Which module is closest to the 400-line limit?',
	'Add a /uptime command that shows when the host process started',
	'What tools do you have available?',
	'Explain the git history of the last week',
]

function pick(cwd: string, halDir: string, turn: number): string {
	const list = cwd === halDir ? placeholders.hal : placeholders.general
	return list[turn % list.length]!
}

export const placeholders = { general, hal, pick }
