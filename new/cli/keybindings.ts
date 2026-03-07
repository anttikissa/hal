// Key → action mapping. Imports directly from the modules that own each function.

import type { KeyEvent } from './keys.ts'
import * as prompt from './prompt.ts'
import { client, quit, restart, suspend, doRender, contentWidth, resetContentHighWater } from '../cli.ts'
import { updateState } from '../ipc.ts'

export function handleInput(k: KeyEvent): void {
	if (k.key === 'k' && k.ctrl) throw new Error('simulated crash (ctrl-k)')
	if (k.key === 'c' && k.ctrl) { quit(); return }

	if ((k.key === 'w' && k.ctrl) || (k.key === 'd' && k.ctrl && !prompt.text())) {
		if (client.getState().tabs.length <= 1) {
			updateState(s => { s.sessions = []; s.activeSessionId = null })
			quit()
			return
		}
		client.send('close')
		prompt.reset()
		resetContentHighWater()
		doRender()
		return
	}

	if (k.key === 't' && k.ctrl) { client.send('open'); prompt.reset(); return }
	if (k.key === 'n' && k.ctrl) { client.nextTab(); doRender(); return }
	if (k.key === 'p' && k.ctrl) { client.prevTab(); doRender(); return }
	if (k.key === 'z' && k.ctrl) { suspend(); return }
	if (k.key === 'r' && k.ctrl) { client.saveDraft(); restart(); return }

	if (k.key === 'enter' && !k.alt && !k.ctrl && !k.cmd) {
		const text = prompt.text().trim()
		prompt.reset()
		if (text) {
			const slash = text.match(/^\/(\w+)\s*(.*)/)
			if (slash) {
				const [, cmd, arg] = slash
				client.send(cmd as any, arg || undefined)
			} else {
				client.onSubmit(text)
				client.send('prompt', text)
			}
		}
		doRender()
		return
	}

	if (prompt.handleKey(k, contentWidth())) {
		doRender()
	}
}
