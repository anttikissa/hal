function closedTabs(showAll: boolean, openIds: Set<string>): any[] {
	if (!showAll) return []
	return sessionStore
		.loadAllSessionMetas()
		.filter((meta) => !openIds.has(meta.id))
		.sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt))
}
function renderTabs(args: string, session: SessionState): CommandResult {
	const trimmed = args.trim()
	if (trimmed && trimmed !== '--all') return { error: 'Usage: /tabs [--all]', handled: true }
	const showAll = trimmed === '--all'
	const openTabs = session.sessions ?? []
	const openIds = new Set(openTabs.map((tab) => tab.id))
	const metaById = new Map(sessionStore.loadAllSessionMetas().map((meta) => [meta.id, meta]))
	const rows = [
		...openTabs.map((tab, index) => {
			const meta = metaById.get(tab.id)
			return {
				id: tab.id,
				where: `tab ${index + 1}`,
				name: sessionDisplayName(meta, tab.name || tab.id),
				createdAt: meta?.createdAt ?? session.createdAt,
				closedAt: meta?.closedAt,
			}
		}),
		...closedTabs(showAll, openIds).map((meta) => ({
			id: meta.id,
			where: 'closed',
			name: sessionDisplayName(meta, meta.id),
			createdAt: meta.createdAt,
			closedAt: meta.closedAt,
		})),
	]
	if (rows.length === 0) return { output: showAll ? 'No sessions.' : 'No open tabs.', handled: true }
	const lines = [showAll ? 'Sessions:' : 'Open tabs:']
	for (const row of rows) {
		const marker = row.id === session.id ? '*' : ' '
		lines.push(`${marker} ${row.where.padEnd(7)} ${row.id}  ${row.name}`)
		const dates = [`start ${formatStamp(row.createdAt)}`]
		if (row.closedAt) dates.push(`end ${formatStamp(row.closedAt)}`)
		lines.push(`          ${dates.join(' · ')}`)
	}
	return { output: lines.join('\n'), handled: true }
}
