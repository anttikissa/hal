import { createEffect, For, onSettled } from 'solid-js'
import { router } from '../router.ts'
import type { AnswerValue } from '../../common/history.ts'
import { webTranscript, type RenderedTranscriptItem } from '../utils/transcript.ts'
import { webScroll } from '../utils/scroll.ts'
import { TranscriptItem } from './TranscriptItem.tsx'

type TranscriptProps = {
	items: RenderedTranscriptItem[]
	onAnswer: (questionId: string, value: AnswerValue) => Promise<boolean>
	token: string
}

export function Transcript(props: TranscriptProps) {
	let element: HTMLElement | undefined
	let bottomGap: number | null = 0
	let openedTarget = ''
	function focusTarget(): void {
		const blockId = router.blockTarget()
		const pasteId = router.pasteTarget()
		if (!blockId && !pasteId) { openedTarget = ''; return }
		const id = blockId || `paste-${encodeURIComponent(pasteId)}`
		const key = `${router.sessionId()}:${id}`
		if (!element || openedTarget === key) return
		const target = document.getElementById(id)
		if (!target || !element.contains(target)) return // The linked session's snapshot may still be loading.
		element.querySelector('.target')?.classList.remove('target')
		const highlight = target.closest('.ToolCard') ?? target
		highlight.classList.add('target')
		if (target instanceof HTMLDetailsElement) target.open = true
		bottomGap = null
		target.scrollIntoView({ block: 'center' })
		openedTarget = key
	}

	function onBlockLinkClick(event: MouseEvent): void {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
		const link = event.target instanceof Element ? event.target.closest('a.Transcript-blockLink') : null
		if (!link || !router.navigateBlock((link as HTMLAnchorElement).hash.slice(1))) return
		event.preventDefault() // The native anchor jump aligns to the top instead of centering.
		openedTarget = '' // Clicking the current hash should focus it again, too.
		focusTarget()
	}
	onSettled(() => {
		window.addEventListener('hashchange', focusTarget)
		return () => window.removeEventListener('hashchange', focusTarget)
	})
	createEffect(() => [props.items, router.sessionId()], focusTarget)
	// The render grows the transcript before the effect runs, so retain the user's last
	// scroll intent instead of measuring the newly enlarged gap in the effect.
	function updateBottomGap(): void {
		if (element) bottomGap = webScroll.bottomGap(element)
	}
	onSettled(() => {
		if (!element) return
		webScroll.toBottom(element)
		// Keyboard and draft growth resize this same pane without changing items.
		// Follow its bottom only while the reader has not scrolled back.
		const observer = new ResizeObserver(() => {
			if (element && bottomGap !== null) webScroll.toBottom(element, bottomGap)
		})
		observer.observe(element)
		return () => observer.disconnect()
	})
	createEffect(
		() => props.items,
		() => {
			if (element && bottomGap !== null) webScroll.toBottom(element, bottomGap)
		},
	)
	return <main class="Transcript" ref={(node) => { element = node }} onScroll={updateBottomGap} onClick={onBlockLinkClick}>
		<For each={props.items} keyed={webTranscript.rowKey}>{(item) => <TranscriptItem item={item()} token={props.token} onAnswer={props.onAnswer} />}</For>
		<div class={['Transcript-cursor', { thinking: webTranscript.thinkingCursor(props.items) }]} aria-label="Hal cursor"><span aria-hidden="true" /></div>
	</main>
}
