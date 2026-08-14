import { createEffect, For } from 'solid-js'
import type { RenderedTranscriptItem } from '../utils/transcript.ts'
import { webScroll } from '../utils/scroll.ts'
import { TranscriptItem } from './TranscriptItem.tsx'

type TranscriptProps = {
	items: RenderedTranscriptItem[]
}

export function Transcript(props: TranscriptProps) {
	createEffect(
		() => props.items,
		() => webScroll.toBottom(),
	)
	return <main class="Transcript">
		<For each={props.items}>{(item) => <TranscriptItem item={item} />}</For>
	</main>
}
