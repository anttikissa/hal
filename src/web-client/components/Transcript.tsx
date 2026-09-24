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
	function focusTool(): void {
		const toolId = router.toolTarget()
		const key = `${router.sessionId()}:${toolId}`
		if (!toolId || !element || openedTarget === key) return
		const details = document.getElementById(`tool-${encodeURIComponent(toolId)}`) as HTMLDetailsElement | null
		if (!details || !element.contains(details)) return // The linked session's snapshot may still be loading.
		element.querySelector('.ToolCard.target')?.classList.remove('target')
		details.closest('.ToolCard')?.classList.add('target')
		details.open = true
		autoFollow = false
		details.scrollIntoView({ block: 'center' })
		openedTarget = key
	}
	onSettled(() => {
		window.addEventListener('hashchange', focusTool)
		return () => window.removeEventListener('hashchange', focusTool)
	})
	createEffect(() => [props.items, router.sessionId()], focusTool)
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
