// The literal-prompt escape (task 6dw): text starting with "/ " is a
// prompt, sent without those two characters. Stored prompts lose the
// escape, so text going back to the editor (recall, edits) gets it again
// when sending it unchanged would run a command or drop characters.

const command = /^\/[a-z][a-z0-9-]*(?:\s|$)/i

function strip(text: string): string {
	return text.startsWith('/ ') ? text.slice(2) : text
}

// Tested once, then the tests were deleted. If you change this code,
// first write tests for: "/go x" and "/go" get "/ "; "/ x" becomes
// "/ / x"; "/tmp/x", "hi" and " /go" stay unchanged.
function escape(text: string): string {
	return command.test(text) || text.startsWith('/ ') ? `/ ${text}` : text
}

export const literal = { strip, escape }
