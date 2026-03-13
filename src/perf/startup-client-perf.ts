// Startup performance tracking for the client.

import type { Block } from '../cli/blocks.ts'
import { startupTrace } from './startup-trace.ts'

export interface StartupPerfState {
	readyMs: number | null
	hostRuntimeMs: number | null
	cliReadyMs: number | null
	epochMs: number | null
	tabMs: number | null
	hydrateMs: number | null
	renderMs: number | null
	targetMs: number
}

export interface StartupPerfHolder {
	state: StartupPerfState | null
}

function sample(): StartupPerfState | null {
	const meta = (globalThis as any).__hal as {
		startupEpochMs?: number | null
		startupReadyElapsedMs?: number | null
		startupHostRuntimeElapsedMs?: number | null
	} | undefined
	const epochRaw = meta?.startupEpochMs
	const epochMs = typeof epochRaw === 'number' && Number.isFinite(epochRaw) && epochRaw > 0 ? epochRaw : null
	const hostRuntimeRaw = meta?.startupHostRuntimeElapsedMs
	const hostRuntimeMs = typeof hostRuntimeRaw === 'number' && Number.isFinite(hostRuntimeRaw) && hostRuntimeRaw >= 0
		? Math.round(hostRuntimeRaw)
		: null
	const readyRaw = meta?.startupReadyElapsedMs
	if (typeof readyRaw === 'number' && Number.isFinite(readyRaw) && readyRaw >= 0) {
		const readyMs = Math.round(readyRaw)
		const cliReadyMs = hostRuntimeMs === null ? null : Math.max(0, readyMs - hostRuntimeMs)
		return { readyMs, hostRuntimeMs, cliReadyMs, epochMs, tabMs: null, hydrateMs: null, renderMs: null, targetMs: 200 }
	}
	if (!epochMs) return null
	const readyMs = Math.max(0, Date.now() - epochMs)
	const cliReadyMs = hostRuntimeMs === null ? null : Math.max(0, readyMs - hostRuntimeMs)
	return { readyMs, hostRuntimeMs, cliReadyMs, epochMs, tabMs: null, hydrateMs: null, renderMs: null, targetMs: 200 }
}

function appendTrace(blocks: Block[]): void {
	for (const line of startupTrace.drainLines()) {
		blocks.push({ type: 'info', text: line })
	}
}

function appendIfReady(holder: StartupPerfHolder, blocks: Block[] | null): void {
	if (!blocks) return
	const sp = holder.state
	if (sp) {
		if (sp.tabMs !== null || sp.epochMs === null) {
			holder.state = null
			if (sp.tabMs !== null) {
				const warn = sp.tabMs > sp.targetMs
				const readyPart = sp.readyMs !== null
					? sp.hostRuntimeMs !== null && sp.cliReadyMs !== null
						? `ready ${sp.readyMs}ms (runtime ${sp.hostRuntimeMs}ms + cli ${sp.cliReadyMs}ms) · `
						: `ready ${sp.readyMs}ms · `
					: ''
				const detail = sp.hydrateMs !== null && sp.renderMs !== null
					? ` (hydrate ${sp.hydrateMs}ms + render ${sp.renderMs}ms)`
					: ''
				blocks.push({
					type: 'info',
					text: `${warn ? '⚠ ' : ''}[perf] startup: ${readyPart}tab ${sp.tabMs}ms${detail} (target <${sp.targetMs}ms tab)`,
				})
			} else if (sp.readyMs !== null) {
				const readyLabel = sp.hostRuntimeMs !== null && sp.cliReadyMs !== null
					? `ready ${sp.readyMs}ms (runtime ${sp.hostRuntimeMs}ms + cli ${sp.cliReadyMs}ms)`
					: `ready ${sp.readyMs}ms`
				blocks.push({
					type: 'info',
					text: `${sp.readyMs > sp.targetMs ? '⚠ ' : ''}[perf] startup: ${readyLabel} (target <${sp.targetMs}ms)`,
				})
			}
		}
	}
	appendTrace(blocks)
}

function captureTab(perf: StartupPerfState | null, hydrateMs: number | null, renderMs: number): void {
	if (!perf) return
	if (perf.tabMs !== null) return
	const roundedHydrate = hydrateMs === null ? null : Math.max(0, Math.round(hydrateMs))
	const roundedRender = Math.max(0, Math.round(renderMs))
	perf.hydrateMs = roundedHydrate
	perf.renderMs = roundedRender
	if (perf.epochMs !== null) {
		perf.tabMs = Math.max(0, Date.now() - perf.epochMs)
		return
	}
	if (perf.readyMs !== null && roundedHydrate !== null) {
		perf.tabMs = perf.readyMs + roundedHydrate + roundedRender
	}
}

function renderAndCapture(
	holder: StartupPerfHolder,
	activeBlocks: Block[] | null,
	activeSessionId: string | null,
	onRender: () => void,
	hydrateMs: number | null,
): void {
	const shouldCapture = !!holder.state && holder.state.tabMs === null && !!activeBlocks
	if (!shouldCapture) {
		appendIfReady(holder, activeBlocks)
		onRender()
		return
	}
	const renderStartedAt = Date.now()
	onRender()
	const renderMs = Date.now() - renderStartedAt
	captureTab(holder.state, hydrateMs, renderMs)
	if (activeSessionId) {
		startupTrace.mark('active-tail-rendered', `${Math.max(0, Math.round(renderMs))}ms (${activeSessionId})`)
		startupTrace.mark('interactive-ready', activeSessionId)
	}
	appendIfReady(holder, activeBlocks)
	onRender()
}

export const startupClientPerf = {
	sample,
	appendTrace,
	appendIfReady,
	captureTab,
	renderAndCapture,
}
