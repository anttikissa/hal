// Key → action mapping. Imports directly from the modules that own each function.

import type { KeyEvent } from './keys.ts'
import * as prompt from './prompt.ts'
import { client, quit, restart, suspend, doRender, contentWidth, showError } from '../cli.ts'

export function handleInput(k: KeyEvent): void {
	if (k.key === 'k' && k.ctrl) throw new Error('simulated crash (ctrl-k)')
	if (k.key === 'c' && k.ctrl) { quit(); return }

	if ((k.key === 'w' && k.ctrl) || (k.key === 'd' && k.ctrl && !prompt.text())) {
		client.saveDraft()
		send('close')
		prompt.reset()
		doRender()
		return
	}

	if (k.key === 't' && k.ctrl) { client.saveDraft(); send('open'); prompt.reset(); return }
	if (k.key === 'n' && k.ctrl) { client.nextTab(); doRender(); return }
	if (k.key === 'p' && k.ctrl) { client.prevTab(); doRender(); return }
	if (k.key === 'z' && k.ctrl) { suspend(); return }
	if (k.key === 'r' && k.ctrl) { client.saveDraft(); restart(); return }
	if (k.alt && !k.ctrl && !k.cmd && k.key >= '1' && k.key <= '9') { client.switchToTab(Number(k.key) - 1); doRender(); return }

	// Question mode: Enter submits answer, Escape dismisses
	if (prompt.hasQuestion()) {
		if (k.key === 'escape') {
			prompt.clearQuestion()
			client.clearQuestion()
			send('respond', '')
			doRender()
			return
		}
		if (k.key === 'enter' && !k.shift && !k.alt && !k.ctrl && !k.cmd) {
			const answer = prompt.clearQuestion()
			client.clearQuestion()
			if (answer.trim()) send('respond', answer.trim())
			else send('respond', '')
			doRender()
			return
		}
	}

	if (k.key === 'escape') {
		const tab = client.activeTab()
		if (tab?.busy) { send('pause'); client.markPausing(); doRender() }
		return
	}

	if (k.key === 'enter' && !k.shift && !k.alt && !k.ctrl && !k.cmd) {
		const text = prompt.text().trim()
		prompt.clear()
		if (text) {
			const slash = text.match(/^\/(\w+)\s*(.*)/)
			if (slash) {
				const [, cmd, arg] = slash
				if (cmd === 'help') { showHelp(); }
				else send(cmd as any, arg || undefined)
			} else {
				client.onSubmit(text)
				prompt.pushHistory(text)
				send('prompt', text)
			}
		}
		doRender()
		return
	}

	if (prompt.handleKey(k, contentWidth())) {
		doRender()
	}
}

function showHelp(): void {
	const tab = client.activeTab()
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
			'  /continue — resume interrupted response',
			'  /resume [id] — reopen a closed session',
			'  /fork — fork session',
			'',
			'**Keys**',
			'  esc pause │ ctrl-t new tab │ ctrl-w close │ ctrl-n/p switch tabs',
			'  ctrl-c quit │ ctrl-z suspend │ ctrl-r restart',
		].join('\n'),
	})
}

function send(type: Parameters<typeof client.send>[0], text?: string): void {
	client.send(type, text).catch((e: Error) => showError(`send ${type}: ${e.message}`))
}