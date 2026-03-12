import { existsSync, readFileSync } from 'fs'
import { state } from '../state.ts'
import { ason } from '../utils/ason.ts'

const parentCache = new Map<string, string | null>()

function getParentSessionId(sessionId: string): string | null {
	const cached = parentCache.get(sessionId)
	if (cached !== undefined) return cached
	const path = `${state.sessionDir(sessionId)}/history.asonl`
	if (!existsSync(path)) {
		parentCache.set(sessionId, null)
		return null
	}
	try {
		const raw = readFileSync(path, 'utf-8')
		const firstLine = raw.split('\n', 1)[0]
		if (!firstLine?.trim()) {
			parentCache.set(sessionId, null)
			return null
		}
		const entry = ason.parse(firstLine) as any
		if (entry?.type === 'forked_from' && entry.parent) {
			parentCache.set(sessionId, entry.parent)
			return entry.parent
		}
	} catch {}
	parentCache.set(sessionId, null)
	return null
}

async function readBlobFromForkChain(
	sessionId: string,
	blobId: string,
	readLocalBlob: (sessionId: string, blobId: string) => Promise<any | null>,
): Promise<any | null> {
	const local = await readLocalBlob(sessionId, blobId)
	if (local) return local
	const parent = getParentSessionId(sessionId)
	if (!parent) return null
	return readBlobFromForkChain(parent, blobId, readLocalBlob)
}

async function loadAllHistory<T extends { ts?: string }>(
	sessionId: string,
	readHistory: (sessionId: string) => Promise<T[]>,
): Promise<T[]> {
	const entries = await readHistory(sessionId)
	if (entries.length > 0 && (entries[0] as any).type === 'forked_from') {
		const parent = (entries[0] as any).parent
		const forkTs = (entries[0] as any).ts
		const parentEntries = await loadAllHistory(parent, readHistory)
		const before = parentEntries.filter((e: any) => !e.ts || e.ts < forkTs)
		// Thinking signatures are bound to the original conversation — invalid in forks
		for (const e of before) delete (e as any).thinkingSignature
		return [...before, ...entries.slice(1)]
	}
	return entries
}

export const historyFork = {
	readBlobFromForkChain,
	loadAllHistory,
}
