import { blocks as blockModule } from '../cli/blocks.ts'
import { perf } from '../perf.ts'

async function load(ctx: any): Promise<void> {
	if (ctx.config.backgroundLoadBlobs) {
		const active = ctx.tabs[ctx.activeTab()]
		if (active) {
			const t0 = performance.now()
			const n = await blockModule.loadBlobs(active.history)
			const blobMs = (performance.now() - t0).toFixed(1)
			perf.mark(`Active tab blobs loaded (${n} blobs, ${blobMs}ms)`)
			if (n > 0) ctx.touchTab(active)
			if (n > 0 && ctx.config.repaintAfterBlobLoad) ctx.onChange(false)
		}
	}
	if (!ctx.config.backgroundLoadTabs) {
		ctx.showStartupSummary()
		return
	}
	const t1 = performance.now()
	let tabCount = 0
	for (const tab of ctx.tabs) {
		if (!tab.loaded) {
			ctx.ensureTabLoaded(tab)
			tabCount++
		}
		if (ctx.config.backgroundLoadBlobs) {
			const n = await blockModule.loadBlobs(tab.history)
			if (n > 0) ctx.touchTab(tab)
			if (n > 0 && tab === ctx.tabs[ctx.activeTab()]) ctx.onChange(false)
		}
	}
	const bgMs = (performance.now() - t1).toFixed(1)
	perf.mark(`All tabs loaded (${tabCount} replayed, ${bgMs}ms)`)
	ctx.showStartupSummary()
}

export const backgroundLoader = { load }
