// Blob refs accepted by read_blob.
//
// Bare blob IDs resolve in the current session. Namespaced refs let the agent
// inspect another session explicitly without guessing which session owns the blob.

interface ParsedBlobRef {
	sessionId: string
	blobId: string
}

function parse(id: string, currentSessionId: string): ParsedBlobRef | null {
	const text = id.trim()
	if (!text) return null

	const slash = text.indexOf('/')
	if (slash < 0) return { sessionId: currentSessionId, blobId: text }
	if (slash !== text.lastIndexOf('/')) return null

	const sessionId = text.slice(0, slash).trim()
	const blobId = text.slice(slash + 1).trim()
	if (!sessionId || !blobId) return null
	return { sessionId, blobId }
}

export const blobRef = { parse }
