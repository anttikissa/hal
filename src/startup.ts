import { resolve } from 'path'
import type { SessionMeta } from './server/sessions.ts'
import type { SharedSessionInfo } from './ipc.ts'

// Startup policy lives here so the CLI wrapper, client and runtime agree on the
// same fatal rule: never attach the user to a different project silently.
const config = {
	maxTabs: 40,
	targetWaitMs: 5_000,
	targetPollMs: 25,
}


type TargetPlan =
	| { kind: 'use-open'; sessionId: string }
	| { kind: 'resume'; sessionId: string }
	| { kind: 'create' }
	| { kind: 'refuse'; reason: string }

type OpenSessionLike = Pick<SharedSessionInfo, 'id' | 'cwd'>

type StoredSessionLike = Pick<SessionMeta, 'id' | 'workingDir' | 'createdAt'>


function normalizeCwd(cwd: string | undefined): string {
	return resolve(cwd || '.')
}

function sameCwd(a: string | undefined, b: string | undefined): boolean {
	return normalizeCwd(a) === normalizeCwd(b)
}

function findOpenSessionForCwd(openSessions: OpenSessionLike[], cwd: string): string | null {
	return openSessions.find((session) => sameCwd(session.cwd, cwd))?.id ?? null
}

function findClosedSessionForCwd(allSessions: StoredSessionLike[], openIds: Set<string>, cwd: string): string | null {
	const matches = allSessions
		.filter((session) => !openIds.has(session.id) && sameCwd(session.workingDir, cwd))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
	return matches[0]?.id ?? null
}

function planTarget(opts: {
	cwd: string
	openSessions: OpenSessionLike[]
	allSessions: StoredSessionLike[]
	maxTabs?: number
}): TargetPlan {
	const maxTabs = opts.maxTabs ?? config.maxTabs
	const openId = findOpenSessionForCwd(opts.openSessions, opts.cwd)
	if (openId) return { kind: 'use-open', sessionId: openId }

	if (opts.openSessions.length >= maxTabs) {
		return {
			kind: 'refuse',
			reason: `Cannot open ${normalizeCwd(opts.cwd)}: max tabs reached (${maxTabs}). Close one first.`,
		}
	}

	const openIds = new Set(opts.openSessions.map((session) => session.id))
	const closedId = findClosedSessionForCwd(opts.allSessions, openIds, opts.cwd)
	if (closedId) return { kind: 'resume', sessionId: closedId }

	return { kind: 'create' }
}

export const startup = {
	config,
	normalizeCwd,
	sameCwd,
	findOpenSessionForCwd,
	findClosedSessionForCwd,
	planTarget,
}
