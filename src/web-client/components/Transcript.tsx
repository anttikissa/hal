import { createEffect, For, onSettled } from 'solid-js'
import { router } from '../router.ts'
import type { AnswerValue } from '../../common/history.ts'
import type { RenderedTranscriptItem } from '../utils/transcript.ts'
import { webScroll } from '../utils/scroll.ts'
import { TranscriptItem } from './TranscriptItem.tsx'

type TranscriptProps = {
	items: RenderedTranscriptItem[]
	onAnswer: (questionId: string, value: AnswerValue) => Promise<boolean>
	token: string
}

export function Transcript(props: TranscriptProps) {
	let element: HTMLElement | undefined
	let autoFollow = true
	let openedTarget = ''
	function focusTarget(): void {
		const toolId = router.toolTarget()
		const pasteId = router.pasteTarget()
		if (!toolId && !pasteId) { openedTarget = ''; return }
		const id = toolId ? `tool-${encodeURIComponent(toolId)}` : `paste-${encodeURIComponent(pasteId)}`
		const key = `${router.sessionId()}:${id}`
		if (!element || openedTarget === key) return
		const details = document.getElementById(id) as HTMLDetailsElement | null
		if (!details || !element.contains(details)) return // The linked session's snapshot may still be loading.
		element.querySelector('.ToolCard.target, .TranscriptItem-paste.target')?.classList.remove('target')
		const highlight = details.closest('.ToolCard') ?? details
		highlight.classList.add('target')
		details.open = true
		autoFollow = false
		details.scrollIntoView({ block: 'center' })
		openedTarget = key
	}
	onSettled(() => {
		window.addEventListener('hashchange', focusTarget)
		return () => window.removeEventListener('hashchange', focusTarget)
	})
	createEffect(() => [props.items, router.sessionId()], focusTarget)
	// The render grows the transcript before the effect runs, so retain the user's last
	// scroll intent instead of measuring the newly enlarged gap in the effect.
	function updateAutoFollow(): void {
		if (element) autoFollow = webScroll.isNearBottom(element)
	}
	onSettled(() => {
		if (!element) return
		webScroll.toBottom(element)
		// Keyboard and draft growth resize this same pane without changing items.
		// Follow its bottom only while the reader has not scrolled back.
		const observer = new ResizeObserver(() => {
			if (element && autoFollow) webScroll.toBottom(element)
		})
		observer.observe(element)
		return () => observer.disconnect()
	})
	createEffect(
		() => props.items,
		() => {
			if (element && autoFollow) webScroll.toBottom(element)
		},
	)
	return <main class="Transcript" ref={(node) => { element = node }} onScroll={updateAutoFollow}>
		<For each={props.items}>{(item) => <TranscriptItem item={item} token={props.token} onAnswer={props.onAnswer} />}</For>
	</main>
}
