import { Show } from 'solid-js'
import type { AnswerValue } from '../../common/history.ts'
import { transcriptTitles } from '../../common/transcript-titles.ts'
import type { RenderedTranscriptItem } from '../utils/transcript.ts'
import { webMarkdown } from '../utils/markdown.ts'
import { webQuestion } from '../utils/question.ts'
import { QuestionBlock } from './QuestionBlock.tsx'
import { ToolCard } from './ToolCard.tsx'

type TranscriptItemProps = {
	item: RenderedTranscriptItem
	onAnswer: (questionId: string, value: AnswerValue) => Promise<boolean>
}

export function TranscriptItem(props: TranscriptItemProps) {
	return <Show
		when={webQuestion.projected(props.item.entry)}
		fallback={<Show
			when={props.item.entry.type === 'tool' ? props.item.entry : undefined}
			fallback={<article class={['TranscriptItem', props.item.entry.type]}>
				<label>{transcriptTitles.label(props.item.entry)}</label>
				<div class="Markdown" innerHTML={webMarkdown.html(props.item.text, 'usageBars' in props.item.entry && props.item.entry.usageBars === true)} />
			</article>}
		>
			{(tool) => <ToolCard tool={tool()} />}
		</Show>}
	>
		{(question) => <QuestionBlock question={question()} onAnswer={props.onAnswer} />}
	</Show>
}
