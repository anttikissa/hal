// Headless TUI test driver. Drives keybindings + prompt without a terminal.

import { handleInput, type InputContext } from './keybindings.ts'
import type { KeyEvent } from './keys.ts'
import * as prompt from './prompt.ts'

export class TestDriver {
	sent: { type: string; text?: string }[] = []
	blocks: any[] = []
	renders = 0
	private ctx: InputContext

	constructor() {
		prompt.reset()
		this.ctx = {
			send: (type, text) => { this.sent.push({ type, text }) },
			activeTab: () => ({ blocks: this.blocks, busy: false, info: { topic: '.hal', workingDir: '~/.hal' } }),
			tabs: () => [{ sessionId: '01-test', info: { topic: '.hal', workingDir: '~/.hal' } }],
			activeTabIndex: () => 0,
			saveDraft: () => {},
			onSubmit: () => {},
			nextTab: () => {},
			prevTab: () => {},
			switchToTab: () => {},
			clearQuestion: () => {},
			markPausing: () => {},
			doRender: () => { this.renders++ },
			contentWidth: () => 80,
			quit: () => {},
			restart: () => {},
			suspend: () => {},
		}
	}

	press(key: string, mods?: Partial<KeyEvent>): void {
		const k: KeyEvent = { key, char: '', ctrl: false, alt: false, shift: false, cmd: false, ...mods }
		handleInput(k, this.ctx)
	}

	type(text: string): void {
		for (const ch of text) this.press(ch, { char: ch })
	}

	enter(): void { this.press('enter') }
	escape(): void { this.press('escape') }

	submit(text: string): void {
		this.type(text)
		this.enter()
	}

	get promptText(): string { return prompt.text() }
	get cursor(): number { return prompt.cursorPos() }

	reset(): void {
		this.sent.length = 0
		this.blocks.length = 0
		this.renders = 0
		prompt.reset()
	}
}
