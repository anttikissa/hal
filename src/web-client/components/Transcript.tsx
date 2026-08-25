import { createEffect, For, onSettled } from 'solid-js'
import type { AnswerValue } from '../../common/history.ts'
import type { RenderedTranscriptItem } from '../utils/transcript.ts'
import { webScroll } from '../utils/scroll.ts'
import { TranscriptItem } from './TranscriptItem.tsx'

type TranscriptProps = {
	items: RenderedTranscriptItem[]
	sessionId: string
	onAnswer: (questionId: string, value: AnswerValue) => Promise<boolean>
}

export function Transcript(props: TranscriptProps) {
	let element: HTMLElement | undefined
	let autoFollow = true
	// The render grows the transcript before the effect runs, so retain the user's last
	// scroll intent instead of measuring the newly enlarged gap in the effect.
	function updateAutoFollow(): void {
		if (element) autoFollow = webScroll.isNearBottom(element)
	}
	onSettled(() => {
		if (element) webScroll.toBottom(element)
	})
	createEffect(
		() => props.items,
		() => {
			if (element && autoFollow) webScroll.toBottom(element)
		},
	)
	return <main class="Transcript" ref={(node) => { element = node }} onScroll={updateAutoFollow}>
		<For each={props.items}>{(item) => <TranscriptItem item={item} sessionId={props.sessionId} onAnswer={props.onAnswer} />}</For>
	</main>
}
