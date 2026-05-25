import { draft as draftModule } from '../cli/draft.ts'
import { blocks as blockModule } from '../cli/blocks.ts'
import { clientHistory } from './history.ts'

function handle(event: any, ctx: any): void {
	if (event.type === 'host-released') return
	if (event.type === 'runtime-start') {
		if (event.pid !== ctx.pid) ctx.showServerRestart(event.pid, event.startedAt)
		return
	}
	if (event.type === 'prompt') return handlePrompt(event, ctx)
	if (event.type === 'stream-start' && event.sessionId) return handleStreamStart(event, ctx)
	if (event.type === 'stream-delta' && event.sessionId && event.text) return handleStreamDelta(event, ctx)
	if (event.type === 'stream-end' && event.sessionId) return handleStreamEnd(event, ctx)
	if (event.type === 'response') return handleResponse(event, ctx)
	if (event.type === 'info') return handleInfo(event, ctx)
	if (event.type === 'tool-call' && event.sessionId) return handleToolCall(event, ctx)
	if (event.type === 'tool-confirm-request' && event.sessionId) return handleToolConfirmRequest(event, ctx)
	if (event.type === 'tool-result' && event.sessionId) return handleToolResult(event, ctx)
	if (event.type === 'draft_saved' && event.sessionId) return handleDraftSaved(event, ctx)
	if (event.type === 'rebase-start') return handleRebaseStart(event, ctx)
	if (event.type === 'rebase-result') return handleRebaseResult(event, ctx)
	if (event.type === 'history-rebased') return handleHistoryRebased(event, ctx)
}

function hasTrailingUserPrompt(tab: any, text: string): boolean {
	const last = tab.history[tab.history.length - 1]
	return last?.type === 'user' && last.text === text
}
function handlePrompt(event: any, ctx: any): void {
	if (event.label === 'steering') ctx.cancelDelayedPaused(event.sessionId ?? null)
	else ctx.flushDelayedPaused(event.sessionId ?? null)
	const tab = ctx.tabForSession(event.sessionId ?? null)
	if (tab && hasTrailingUserPrompt(tab, event.text)) return
	ctx.addBlockToTab(event.sessionId, {
		type: 'user',
		text: event.text,
		source: typeof event.source === 'string' ? event.source : undefined,
		status: event.label,
		ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
	})
}

function handleStreamStart(event: any, ctx: any): void {
	ctx.flushDelayedPaused(event.sessionId)
	const tab = ctx.tabForSession(event.sessionId)
	if (tab) ctx.applyLiveEventToTab(tab, event)
}

function handleStreamDelta(event: any, ctx: any): void {
	ctx.flushDelayedPaused(event.sessionId)
	const tab = ctx.tabForSession(event.sessionId)
	if (tab && ctx.applyLiveEventToTab(tab, event).changed) ctx.repaintIfActive(tab)
}

function handleStreamEnd(event: any, ctx: any): void {
	ctx.flushDelayedPaused(event.sessionId)
	const tab = ctx.tabForSession(event.sessionId)
	if (!tab) return
	ctx.applyLiveEventToTab(tab, event)
	if (event.usage) {
		tab.usage ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
		tab.usage.input += event.usage.input ?? 0
		tab.usage.output += event.usage.output ?? 0
		tab.usage.cacheRead += event.usage.cacheRead ?? 0
		tab.usage.cacheCreation += event.usage.cacheCreation ?? 0
	}
	if (event.contextUsed != null) tab.contextUsed = event.contextUsed
	if (event.contextMax != null) tab.contextMax = event.contextMax
	ctx.repaintIfActive(tab)
}

function handleResponse(event: any, ctx: any): void {
	ctx.flushDelayedPaused(event.sessionId ?? null)
	const tab = ctx.tabForSession(event.sessionId ?? null)
	if (!tab) return
	ctx.applyLiveEventToTab(tab, { type: 'stream-end' })
	if (event.isError) {
		ctx.applyLiveEventToTab(tab, event)
		ctx.onChange(false)
	} else if (event.text && !clientHistory.hasTrailingAssistantText(tab.history, event.text)) {
		ctx.addBlockToTab(event.sessionId ?? null, {
			type: 'assistant',
			text: event.text,
			model: typeof event.model === 'string' ? event.model : undefined,
			synthetic: event.synthetic === true,
			ts: event.createdAt ? Date.parse(event.createdAt) : undefined,
		})
	}
}

function handleInfo(event: any, ctx: any): void {
	const sessionId = event.sessionId ?? null
	const tab = ctx.tabForSession(sessionId)
	if (tab) ctx.applyLiveEventToTab(tab, { type: 'stream-end' })
	if (event.level !== 'error' && event.text === '[paused]') {
		ctx.scheduleDelayedPaused(sessionId, { type: 'log', text: event.text, ts: event.createdAt ? Date.parse(event.createdAt) : undefined })
		return
	}
	ctx.flushDelayedPaused(sessionId)
	if (!tab) return
	ctx.applyLiveEventToTab(tab, event)
	ctx.onChange(false)
}

function handleToolCall(event: any, ctx: any): void {
	ctx.flushDelayedPaused(event.sessionId)
	const tab = ctx.tabForSession(event.sessionId)
	if (!tab) return
	ctx.applyLiveEventToTab(tab, event)
	ctx.onChange(false)
}

function handleToolConfirmRequest(event: any, ctx: any): void {
	ctx.flushDelayedPaused(event.sessionId)
	ctx.markToolConfirmPending(event.sessionId)
	ctx.onToolConfirmRequest(event)
	ctx.onChange(false)
}

function handleToolResult(event: any, ctx: any): void {
	ctx.flushDelayedPaused(event.sessionId)
	ctx.clearToolConfirmPending(event.sessionId)
	const tab = ctx.tabForSession(event.sessionId)
	const toolBlock = tab ? ctx.applyLiveEventToTab(tab, event).toolBlock : null
	if (!tab || !toolBlock) return
	delete toolBlock.blobLoaded
	ctx.onChange(false)
	if (!toolBlock.blobId) return
	void (async () => {
		const loaded = await blockModule.loadBlobs([toolBlock])
		if (loaded <= 0) return
		ctx.touchTab(tab)
		ctx.onChange(false)
	})()
}

function handleDraftSaved(event: any, ctx: any): void {
	ctx.flushDelayedPaused(event.sessionId)
	const tab = ctx.tabForSession(event.sessionId)
	if (!tab) return
	const text = draftModule.loadDraft(event.sessionId)
	tab.inputDraft = text
	if (ctx.currentTab()?.sessionId === event.sessionId) ctx.onDraftArrived(text)
}

function isTargetedHere(event: any, ctx: any): boolean {
	return !event.targetPid || event.targetPid === ctx.pid
}

function handleRebaseStart(event: any, ctx: any): void {
	if (!isTargetedHere(event, ctx)) return
	ctx.onRebaseStart(event)
}

function handleRebaseResult(event: any, ctx: any): void {
	if (!isTargetedHere(event, ctx)) return
	ctx.onRebaseResult(event)
}

function handleHistoryRebased(event: any, ctx: any): void {
	const tab = ctx.tabForSession(event.sessionId)
	if (!tab) return
	ctx.reloadTabFromDisk(tab)
	ctx.onChange(true)
}

export const clientEvents = { handle }
