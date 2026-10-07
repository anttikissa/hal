// Interrupted text's display-only tail. Markdown trims trailing whitespace;
// restore it before the marker, without changing prose or provider input.
// Tasks: 6eq.
function tail(text: string): string {
	return (text.match(/\s*$/)?.[0] ?? '') + (/\S$/.test(text) ? ' --' : '--')
}
export const interruption = { tail }
