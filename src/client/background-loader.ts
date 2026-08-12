import { blockData } from './terminal/block-data.ts'
import { perf } from '../perf.ts'

async function load(ctx: any): Promise<void> {
	if (ctx.config.backgroundLoadBlobs) {
		const focused = ctx.tabs[ctx.focusedTabIndex()]
		if (focused) {
			const t0 = performance.now()
			const n = await blockData.loadBlobs(focused.history)
			const blobMs = (performance.now() - t0).toFixed(1)
			perf.mark(`Focused tab blobs loaded (${n} blobs, ${blobMs}ms)`)
			if (n > 0) ctx.touchTab(focused)
			if (n > 0 && ctx.config.repaintAfterBlobLoad) ctx.onChange(false)
		}
	}
	if (!ctx.config.backgroundLoadTabs) return
	const t1 = performance.now()
	let tabCount = 0
	for (const tab of ctx.tabs) {
		if (!tab.loaded) {
			ctx.ensureTabLoaded(tab)
			tabCount++
		}
		if (ctx.config.backgroundLoadBlobs) {
			const n = await blockData.loadBlobs(tab.history)
			if (n > 0) ctx.touchTab(tab)
			if (n > 0 && tab === ctx.tabs[ctx.focusedTabIndex()]) ctx.onChange(false)
		}
	}
	const bgMs = (performance.now() - t1).toFixed(1)
	perf.mark(`All tabs loaded (${tabCount} replayed, ${bgMs}ms)`)
}

export const backgroundLoader = { load }
