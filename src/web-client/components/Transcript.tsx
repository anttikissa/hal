import { createEffect, For, onSettled, Show } from 'solid-js'
import { router } from '../router.ts'
import type { AnswerValue } from '../../common/history.ts'
import { webTranscript, type RenderedTranscriptItem } from '../utils/transcript.ts'
import { webScroll } from '../utils/scroll.ts'
import { TranscriptItem } from './TranscriptItem.tsx'

type TranscriptProps = {
	items: RenderedTranscriptItem[]
	sendCount: number
	onAnswer: (questionId: string, value: AnswerValue) => Promise<boolean>
	token: string
}

export function Transcript(props: TranscriptProps) {
	let element: HTMLElement | undefined
	let bottomGap: number | null = 0
	let openedTarget = ''
	let smoothFollow = false
	let lastCount = 0
	let lastSession = ''
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
		smoothFollow = false
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

	function onCardClick(event: MouseEvent): void {
		if (!element || !(event.target instanceof Element) || event.target.closest('a, button, textarea, input, select')) return
		const card = event.target.closest('.ToolCard')
		if (!card || !element.contains(card)) return
		if (window.getSelection()?.isCollapsed === false) { event.preventDefault(); return }
		const details = card.querySelector('details')
		if (!details) return
		event.preventDefault() // The summary's native toggle would undo our measured toggle.
		webScroll.keepBottom(element, () => { details.open = !details.open })
	}
	onSettled(() => {
		window.addEventListener('hashchange', focusTarget)
		return () => window.removeEventListener('hashchange', focusTarget)
	})
	createEffect(() => [props.items, router.sessionId()], focusTarget)
	// The render grows the transcript before the effect runs, so retain the user's last
	// scroll intent instead of measuring the newly enlarged gap in the effect.
	function updateBottomGap(): void {
		if (element && !smoothFollow) bottomGap = webScroll.bottomGap(element)
	}
	function cancelSmoothFollow(): void {
		if (!smoothFollow || !element) return
		smoothFollow = false
		bottomGap = webScroll.bottomGap(element)
		element.scrollTo({ top: element.scrollTop, behavior: 'instant' }) // Stop the browser's in-flight scroll.
	}
	onSettled(() => {
		if (!element) return
		webScroll.toBottom(element)
		// Keyboard and draft growth resize this same pane without changing items.
		// Follow its bottom only while the reader has not scrolled back.
		const observer = new ResizeObserver(() => {
			if (element && bottomGap !== null) webScroll.toBottom(element, bottomGap, smoothFollow)
		})
		observer.observe(element)
		return () => observer.disconnect()
	})
	createEffect(
		() => props.items,
		(items) => {
			const session = router.sessionId()
			const appended = session === lastSession && items.length > lastCount
			lastSession = session
			lastCount = items.length
			if (!element || bottomGap === null) return
			smoothFollow = (smoothFollow || appended) && !matchMedia('(prefers-reduced-motion: reduce)').matches
			webScroll.toBottom(element, bottomGap, smoothFollow)
		},
	)
	createEffect(() => props.sendCount, (count) => {
		if (!count || !element) return
		bottomGap = 0
		smoothFollow = !matchMedia('(prefers-reduced-motion: reduce)').matches
		webScroll.toBottom(element, 0, smoothFollow)
	})
	return <main class="Transcript" ref={(node) => { element = node }} onScroll={updateBottomGap} onScrollEnd={() => { smoothFollow = false; updateBottomGap() }} onWheel={cancelSmoothFollow} onTouchStart={cancelSmoothFollow} onClick={(event) => { onCardClick(event); onBlockLinkClick(event) }}>
		<For each={props.items} keyed={webTranscript.rowKey}>{(item) => <TranscriptItem item={item()} cursor={webTranscript.activeCursorEntry(props.items) === item().entry} token={props.token} onAnswer={props.onAnswer} />}</For>
		<Show when={!webTranscript.activeCursorEntry(props.items)}><div class="Transcript-cursor" aria-label="Hal cursor"><span aria-hidden="true" /></div></Show>
	</main>
}
