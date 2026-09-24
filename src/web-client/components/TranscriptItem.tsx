import { For, Show } from 'solid-js'
import type { AnswerValue } from '../../common/history.ts'
import { transcriptTitles } from '../../common/transcript-titles.ts'
import { historyProjection } from '../../common/history-projection.ts'
import { webTranscript, type RenderedTranscriptItem } from '../utils/transcript.ts'
import { webMarkdown } from '../utils/markdown.ts'
import { webQuestion } from '../utils/question.ts'
import { QuestionBlock } from './QuestionBlock.tsx'
import { ToolCard } from './ToolCard.tsx'
import { router } from '../router.ts'

type TranscriptItemProps = {
	item: RenderedTranscriptItem
	token: string
	onAnswer: (questionId: string, value: AnswerValue) => Promise<boolean>
	cursor?: boolean
}

export function TranscriptItem(props: TranscriptItemProps) {
	return <Show
		when={webQuestion.projected(props.item.entry)}
		fallback={<Show
			when={props.item.entry.type === 'tool' ? props.item.entry : undefined}
			fallback={<article class={['TranscriptItem', props.item.entry.type, { streaming: !!props.cursor }]} id={webTranscript.blockId(props.item.entry) || undefined}>
				<header><strong>{transcriptTitles.label(props.item.entry)}</strong>
					<Show when={router.blockHash(webTranscript.blockId(props.item.entry))}>
						{(hash) => <a class="Transcript-blockLink" href={hash()}>{webTranscript.blockId(props.item.entry)}</a>}
					</Show>
				</header>
				<div class="Markdown">
					<Show when={'continuedAfter' in props.item.entry && props.item.entry.continuedAfter}>
						<span class="TranscriptItem-interruption">{historyProjection.continuationText()} </span>
					</Show>
					<div class="TranscriptItem-content">
						<Show when={props.item.entry.type === 'user' && !('text' in props.item.entry && typeof props.item.entry.text === 'string') && 'parts' in props.item.entry ? props.item.entry.parts : undefined}
							fallback={<div innerHTML={webMarkdown.html(props.item.text, 'usageBars' in props.item.entry && props.item.entry.usageBars === true)} />}>
							{(parts) => <For each={parts()}>{(part) => part.type === 'text'
								? <For each={part.displayText ? webTranscript.pasteSegments(part.displayText) : [part.text]}>{(segment) => part.displayText && props.item.entry.id && webTranscript.isPasteMarker(segment)
									? <a href={router.pasteHash(props.item.entry.id)}>{segment}</a>
									: <div class="TranscriptItem-part" innerHTML={webMarkdown.html(segment)} />}</For>
								: <Show when={webTranscript.imageHref(router.sessionId(), part.blobId, props.token)} fallback={<span>{part.originalFile ? `[${part.originalFile}]` : '[image]'}</span>}>
									{(href) => <a href={href()} target="_blank" rel="noreferrer">{part.originalFile ? `[${part.originalFile}]` : '[image]'}</a>}
								</Show>}</For>}
						</Show>
					</div>
					<Show when={props.cursor}><span class={['Transcript-cursor', { thinking: props.item.entry.type === 'thinking' }, 'inline']} aria-label="Hal cursor"><span aria-hidden="true" /></span></Show>
					<Show when={webTranscript.interruption(props.item.entry)}>
						{(interruption) => <span class="TranscriptItem-interruption"> {interruption()}</span>}
					</Show>
				</div>
				<Show when={webTranscript.pastedText(props.item.entry)}>
					{(text) => <details class="TranscriptItem-paste" id={props.item.entry.id ? `paste-${encodeURIComponent(props.item.entry.id)}` : undefined}>
						<summary>View pasted text</summary>
						<button type="button" onClick={() => void navigator.clipboard.writeText(text())}>Copy text</button>
						<textarea readonly rows={10} spellcheck={false} aria-label="Pasted text" value={text()} />
					</details>}
				</Show>
			</article>}
		>
			{(tool) => <ToolCard tool={tool()} />}
		</Show>}
	>
		{(question) => <QuestionBlock question={question()} onAnswer={props.onAnswer} />}
	</Show>
}
