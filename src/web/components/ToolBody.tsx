/// <reference lib="dom" />
// An open tool card's body (Card.tsx): the call once (task 8t), then its
// output, the result or what has streamed so far; an EDIT's diff; or a
// presented result with its raw call and result behind a disclosure.

import { For, Show } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { diff } from '../../common/diff.ts'
import { titles } from '../../common/titles.ts'
import { toolDetails } from '../../common/tool-details.ts'
import type { ToolPresentation as Presentation } from '../../common/tool-presentation.ts'
import { folds } from '../folds.ts'
import type { Row } from '../transcript-rows.ts'
import type { Shown } from '../view.ts'
import { CardHeader } from './CardHeader.tsx'
import { Disclosure } from './Disclosure.tsx'
import { ToolCommand } from './ToolCommand.tsx'
import { ToolPresentation } from './ToolPresentation.tsx'

// `id`: the card's fold id; `full`: the whole command and output;
// `result`: the result as shown (view.show); `call`: the command lines.
export function ToolBody(props: {
	row: Row
	id: string
	full: boolean
	bash: boolean
	result: Shown | undefined
	presentation: Presentation | undefined
	presentationError: string | undefined
	call: string[]
	failed: boolean
}) {
	let resultTime = () => (props.row.result ? titles.resultTime(props.row.item.ts, props.row.result.ts) : '')
	let resultSection = (label: JSX.Element) =>
		resultTime() ? (
			<div class="result-output">
				<CardHeader inline time={resultTime()} label={label} result={props.row.result} bash={props.bash} />
			</div>
		) : (
			label
		)
	let command = (
		<Show when={props.call.length}>
			<ToolCommand lines={props.call} compact={!props.full} />
		</Show>
	)
	let body = () => {
		let item = props.row.item
		if (item.type !== 'tool') return undefined
		if ((props.presentation || props.presentationError) && props.full)
			return (
				<>
					<Show when={props.presentationError}>{(error) => <div class="error">{error()}</div>}</Show>
					<Show when={!props.presentation}>{command}</Show>
					{resultSection(
						<>
							<Show
								when={
									props.row.result &&
									(props.row.result.isError || props.row.result.interrupted || !props.presentation) &&
									props.row.result.output
								}
							>
								{(output) => <div class={props.row.result?.isError ? 'error' : ''}>{output()}</div>}
							</Show>
							<Show when={props.presentation}>
								{(p) => <ToolPresentation presentation={p()} output={props.row.result?.output} />}
							</Show>
						</>,
					)}
					<Show when={!props.row.result && item.partial}>{(output) => <div>{output()}</div>}</Show>
					<div class="raw-tool">
						<Disclosure
							name="Raw call and result"
							open={folds.raw().has(props.id)}
							onClick={() => folds.setRaw((s) => folds.toggled(s, props.id, !s.has(props.id)))}
						>
							Raw call and result
						</Disclosure>
						<Show when={folds.raw().has(props.id)}>
							<pre>
								{item.cmd ?? toolDetails.value(item.input).join('\n')}
								{'\n\n'}
								{props.row.result?.output ?? item.partial ?? ''}
							</pre>
						</Show>
					</div>
				</>
			)
		// An EDIT's diff shows its edits, so it stands alone, in diff colors.
		if (props.row.result?.diff)
			return resultSection(
				<div class="edit-diff diff">
					<For each={props.result!.text.split('\n')}>{(r) => <div class={diff.tone(r)}>{r}</div>}</For>
				</div>,
			)
		// The call once (task 8t), then its output: the result, or what
		// has streamed so far.
		let out = props.result?.text ?? item.partial?.replace(/\n$/, '')
		return (
			<>
				<Show when={props.presentationError}>{(error) => <div class="error">{error()}</div>}</Show>
				{command}
				{out ? resultSection(<span class={props.failed ? 'result-text error' : 'result-text'}>{out}</span>) : ''}
			</>
		)
	}
	return <>{body()}</>
}
