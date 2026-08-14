import { createEffect, For } from 'solid-js'
import type { RenderedTranscriptItem } from '../utils/transcript.ts'
import { TranscriptItem } from './TranscriptItem.tsx'

type TranscriptProps = {
	items: RenderedTranscriptItem[]
}

export function Transcript(props: TranscriptProps) {
	let element: HTMLElement | undefined
	createEffect(
		() => props.items,
		() => {
			if (element) element.scrollTop = element.scrollHeight
		},
	)
	return <main class="Transcript" ref={(next) => { element = next }}>
		<For each={props.items}>{(item) => <TranscriptItem item={item} />}</For>
	</main>
}
