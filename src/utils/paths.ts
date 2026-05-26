import { STATE_DIR } from '../state.ts'

function formatHomePath(path: string): string {
	const home = process.env.HOME
	if (!home) return path
	if (path === home) return '~'
	if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`
	return path
}

function historyDisplayPath(sessionId: string, logName = 'history.asonl'): string {
	return formatHomePath(`${STATE_DIR}/sessions/${sessionId}/${logName}`)
}

export const paths = { formatHomePath, historyDisplayPath }
