// Key → action mapping. Dependencies injected via InputContext.

import type { KeyEvent } from './keys.ts'
import { clipboard } from './clipboard.ts'
import { completion } from './completion.ts'
import { prompt } from './prompt.ts'
export interface InputContext {
	send: (type: string, text?: string) => void
	activeTab: () => { blocks: any[]; busy?: boolean; info?: any } | null
	tabs: () => { sessionId: string; info?: any }[]
	activeTabIndex: () => number
	saveDraft: () => void
	onSubmit: () => void
	nextTab: () => void
	prevTab: () => void
	switchToTab: (i: number) => void
	clearQuestion: () => void
	markPausing: () => void
	doRender: () => void
	contentWidth: () => number
	quit: () => void
	restart: () => void
	suspend: () => void
}

export function handleInput(k: KeyEvent, ctx: InputContext): void {
	if (k.key === 'c' && k.ctrl) { ctx.quit(); return }

	if (k.key === 'd' && k.ctrl && !prompt.text()) { ctx.quit(); return }
	if (k.key === 'w' && k.ctrl) {
		ctx.saveDraft()
		ctx.send('close')
		prompt.reset()
		ctx.doRender()
		return
	}

	if (k.key === 't' && k.ctrl) { ctx.saveDraft(); ctx.send('open'); prompt.reset(); return }
	if (k.key === 'f' && k.ctrl) { ctx.saveDraft(); ctx.send('fork'); prompt.reset(); return }
	if (k.key === 'n' && k.ctrl) { ctx.nextTab(); ctx.doRender(); return }
	if (k.key === 'p' && k.ctrl) { ctx.prevTab(); ctx.doRender(); return }
	if (k.key === 'z' && k.ctrl) { ctx.suspend(); return }
	if (k.key === 'r' && k.ctrl) { ctx.saveDraft(); ctx.restart(); return }
	if (k.alt && !k.ctrl && !k.cmd && k.key >= '1' && k.key <= '9') { ctx.switchToTab(Number(k.key) - 1); ctx.doRender(); return }

	// Question mode: Enter submits answer, Escape dismisses
	if (prompt.hasQuestion()) {
		if (k.key === 'escape') {
			prompt.clearQuestion()
			ctx.clearQuestion()
			ctx.send('respond', '')
			ctx.doRender()
			return
		}
		if (k.key === 'enter' && !k.shift && !k.alt && !k.ctrl && !k.cmd) {
			const answer = prompt.clearQuestion()
			ctx.clearQuestion()
			if (answer.trim()) ctx.send('respond', answer.trim())
			else ctx.send('respond', '')
			ctx.doRender()
			return
		}
	}

	if (k.key === 'escape') {
		const tab = ctx.activeTab()
		if (tab?.busy) { ctx.send('pause'); ctx.markPausing(); ctx.doRender() }
		return
	}

	if (k.key === 'tab' && !k.ctrl && !k.alt && !k.cmd) {
		const r = completion.completeInput(prompt.text(), prompt.cursorPos(), {
			tabs: ctx.tabs(),
			activeTabIndex: ctx.activeTabIndex(),
		})
		if (r) {
			prompt.setText(r.text, r.cursor)
			if (r.options.length > 1) {
				const tab = ctx.activeTab()
				if (tab) tab.blocks.push({ type: 'info', text: r.options.join('  ') })
			}
			ctx.doRender()
		}
		return
	}

	if (k.key === 'enter' && !k.shift && !k.alt && !k.ctrl && !k.cmd) {
		if (clipboard.hasPendingPastes()) return // wait for image resolution
		const text = prompt.text().trim()
		prompt.clear()
		if (text) {
			const slash = text.match(/^\/(\w+)\s*(.*)/)
			if (slash) {
				const [, cmd, arg] = slash
				if (cmd === 'help') showHelp(ctx)
				else ctx.send(cmd, arg || undefined)
			} else {
				ctx.onSubmit()
				prompt.pushHistory(text)
				ctx.send('prompt', text)
			}
		} else {
			ctx.send('continue')
		}
		ctx.doRender()
		return
	}

	if (prompt.handleKey(k, ctx.contentWidth())) {
		ctx.doRender()
	}
}

function showHelp(ctx: InputContext): void {
	const tab = ctx.activeTab()
	if (!tab) return
	tab.blocks.push({
		type: 'assistant', done: true,
		text: [
			'**Commands**',
			'  /help — show this help',
			'  /reset — clear conversation',
			'  /compact — compact context (keeps user prompt summary)',
			'  /model <name> — switch model (e.g. opus, sonnet-4-6, anthropic/...)',
			'  /topic <name> — set tab topic',
			'  Enter (empty) — continue interrupted response',
			'  /continue — same as above',
			'  /resume [id] — reopen a closed session',
			'  /fork — fork session',
			'',
			'**Keys**',
			'  esc pause │ ctrl-t new tab │ ctrl-f fork │ ctrl-w close │ ctrl-n/p switch tabs',
			'  ctrl-c/d quit │ ctrl-z suspend │ ctrl-r restart',
		].join('\n'),
	})
}

export const keybindings = { handleInput }
