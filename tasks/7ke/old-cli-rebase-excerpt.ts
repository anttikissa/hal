207-
208-
209:function rebaseRequestId(): string {
210-	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
211-}
212-
213-async function runExternalEditor(path: string): Promise<number> {
214-	const editor = process.env.EDITOR || process.env.VISUAL || 'vim'
215-	const wasTty = process.stdin.isTTY
216-	clearPendingPaint()
217-	// Clear Hal's frame before handing the terminal to the editor. The latch is
218-	// enabled immediately after this, so later Hal paints are dropped while the
219-	// editor owns stdout.
220-	render.clearFrame()
221-	terminalOutput.setExternalEditorOpen(true)
222-	process.stdin.pause()
223-	cleanupTerminal()
224-	await terminalOutput.flush()
225-	try {
226-		const proc = Bun.spawn(['sh', '-c', `${editor} "$1"`, 'hal-editor', path], {
227-			stdin: 'inherit',
228-			stdout: 'inherit',
229-			stderr: 'inherit',
230-		})
231-		return await proc.exited
232-	} finally {
233-		terminalOutput.setExternalEditorOpen(false)
234-		terminalCleaned = false
--
252-
253-async function openRebaseEditor(event: any): Promise<void> {
254:	const path = `${tmpdir()}/hal-rebase-${event.sessionId}-${event.requestId}.txt`
255-	writeFileSync(path, String(event.todo ?? ''))
256-	const code = await runExternalEditor(path)
257-	if (code !== 0) {
258-		client.addEntry(`Rebase editor exited with code ${code}`, 'error')
259-		return
260-	}
261-	const todo = readFileSync(path, 'utf-8')
262-	const edits: Record<string, string> = {}
263-	for (const line of todo.split('\n')) {
264-		const match = line.match(/^edit\s+(\S+)\s+/)
265-		if (!match) continue
266-		const id = match[1]!
267-		const rowText = event.editTexts?.[id]
268-		if (typeof rowText !== 'string') continue
269:		const editPath = `${tmpdir()}/hal-rebase-${event.sessionId}-${event.requestId}-${id}.txt`
270-		writeFileSync(editPath, rowText)
271-		const editCode = await runExternalEditor(editPath)
272-		if (editCode !== 0) {
273-			client.addEntry(`Rebase edit editor exited with code ${editCode}`, 'error')
274-			return
275-		}
276-		edits[id] = readFileSync(editPath, 'utf-8')
277-	}
278:	client.sendCommand('rebase-apply', JSON.stringify({ todo, edits }), String(event.requestId ?? ''))
279-}
280-
281-function handleRebaseStart(event: any): void {
282-	void openRebaseEditor(event)
283-}
284-
285-function handleRebaseResult(event: any): void {
286-	if (event.ok) {
287-		if (event.unchanged) client.addEntry('Rebase unchanged.')
288-		else if (event.aborted) client.addEntry('Rebase aborted.')
289-		else client.addEntry(`Rebased to ${event.newLog}${event.queued ? `; queued ${event.queued}` : ''}.`)
290-		draw(true)
291-		return
292-	}
293-	const errors = Array.isArray(event.errors) ? event.errors.map(String) : ['Rebase failed']
294-	if (event.todo) {
295-		void openRebaseEditor({ ...event, todo: `${errors.map((err: string) => `# ${err}`).join('\n')}\n${event.todo}` })
296-		return
297-	}
298-	client.addEntry(errors.join('\n'), 'error')
299-	draw(true)
300-}
301-
302-const SIDE_EFFECT_TOOL_NAMES = new Set(['bash', 'edit', 'write', 'eval', 'send', 'spawn_agent'])
