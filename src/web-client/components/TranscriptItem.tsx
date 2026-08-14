import { transcriptTitles } from '../../common/transcript-titles.ts'
import type { RenderedTranscriptItem } from '../utils/transcript.ts'

type TranscriptItemProps = {
	item: RenderedTranscriptItem
}

export function TranscriptItem(props: TranscriptItemProps) {
	return <article class={['TranscriptItem', props.item.entry.type]}>
		<label>{transcriptTitles.label(props.item.entry)}</label>
		<div>{props.item.text}</div>
	</article>
}
