// Rewrite thinking blobs so they keep only the minimal replay signature.

import { existsSync, readdirSync, writeFileSync } from 'fs'
import { blob } from './blob.ts'
import { ason } from '../utils/ason.ts'
import { reasoningSignature } from './reasoning-signature.ts'

interface CompactResult {
	sessions: number
	blobs: number
	rewritten: number
}

async function compactSessions(sessionIds: string[]): Promise<CompactResult> {
	const result: CompactResult = { sessions: sessionIds.length, blobs: 0, rewritten: 0 }

	for (const sessionId of sessionIds) {
		const dir = blob.blobsDir(sessionId)
		if (!existsSync(dir)) continue
		for (const name of readdirSync(dir)) {
			if (!name.endsWith('.ason')) continue
			result.blobs++
			const path = `${dir}/${name}`
			let data: any
			try {
				data = ason.parse(await Bun.file(path).text())
			} catch {
				continue
			}
			const minimized = reasoningSignature.minimize(data?.signature)
			if (!minimized || minimized === data.signature) continue
			data.signature = minimized
			writeFileSync(path, ason.stringify(data) + '\n')
			result.rewritten++
		}
	}

	return result
}

export const compactThinkingBlobs = { compactSessions }
