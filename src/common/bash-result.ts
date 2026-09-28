// Presentation of a Bash result. Keep the original output in history
// and provider input; a successful exit status is only redundant in UI.
function display(output: string): string {
	return output.startsWith('[exit 0]\n') ? output.slice(9) : output
}

export const bashResult = { display }
