import { Show } from 'solid-js'
import type { AnswerValue } from '../../common/history.ts'
import { transcriptTitles } from '../../common/transcript-titles.ts'
import type { RenderedTranscriptItem } from '../utils/transcript.ts'
import { webQuestion } from '../utils/question.ts'
import { QuestionBlock } from './QuestionBlock.tsx'

type TranscriptItemProps = {
	item: RenderedTranscriptItem
	onAnswer: (questionId: string, value: AnswerValue) => Promise<boolean>
}

export function TranscriptItem(props: TranscriptItemProps) {
	return <Show
		when={webQuestion.projected(props.item.entry)}
		fallback={<article class={['TranscriptItem', props.item.entry.type]}>
			<label>{transcriptTitles.label(props.item.entry)}</label>
			<div>{props.item.text}</div>
		</article>}
	>
		{(question) => <QuestionBlock question={question()} onAnswer={props.onAnswer} />}
	</Show>
}
