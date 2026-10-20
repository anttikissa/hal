// Shows exactly where interrupted text stopped. Markdown trims trailing
// whitespace, so this restores it before the interruption marker, for
// display only: prose and provider input stay unchanged.
// Tasks: 6eq.
function tail(text: string): string {
	return (text.match(/\s*$/)?.[0] ?? '') + (/\S$/.test(text) ? ' --' : '--')
}
export const interruption = { tail }
