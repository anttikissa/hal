import { createEffect, For, onSettled } from 'solid-js'
import type { RenderedTranscriptItem } from '../utils/transcript.ts'
import { webScroll } from '../utils/scroll.ts'
import { TranscriptItem } from './TranscriptItem.tsx'

type TranscriptProps = {
	items: RenderedTranscriptItem[]
}

export function Transcript(props: TranscriptProps) {
	let autoFollow = true
	// The render grows the document before the effect runs, so retain the user's last
	// scroll intent instead of measuring the newly enlarged gap in the effect.
	function updateAutoFollow(): void {
		autoFollow = webScroll.isNearBottom()
	}
	onSettled(() => {
		window.addEventListener('scroll', updateAutoFollow, { passive: true })
		return () => window.removeEventListener('scroll', updateAutoFollow)
	})
	createEffect(
		() => props.items,
		() => {
			if (autoFollow) webScroll.toBottom()
		},
	)
	return <main class="Transcript">
		<For each={props.items}>{(item) => <TranscriptItem item={item} />}</For>
	</main>
}
