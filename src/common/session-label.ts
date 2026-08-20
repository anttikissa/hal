import type { SharedSessionInfo } from './ipc.ts'

function format(session: Pick<SharedSessionInfo, 'id' | 'name' | 'tab'>): string {
	const details: string[] = []
	if (session.name && session.name !== session.id) details.push(session.name)
	if (Number.isInteger(session.tab) && session.tab! > 0) details.push(`tab ${session.tab}`)
	if (details.length === 0) return session.id
	return `${session.id} (${details.join(', ')})`
}

export const sessionLabel = { format }
