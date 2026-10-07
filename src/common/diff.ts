// Shared diff presentation; generation belongs on the host (task k8y).
export type DiffTone = 'add' | 'del' | 'dim'
function tone(line: string): DiffTone {
	return line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'dim'
}
function fence(text: string): string {
	let length = 3
	for (let match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
	let mark = '`'.repeat(length)
	return `${mark}diff\n${text}\n${mark}`
}
export const diff = { tone, fence }
