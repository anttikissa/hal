/// <reference lib="dom" />
// An open prompt-file change card's body (task ar): its summary rows
// with word tones, then each changed file's diff.

import { For } from 'solid-js'
import { diff } from '../../common/diff.ts'
import { promptChanges } from '../../common/prompt-changes.ts'
import type { Item } from '../../common/transcript.ts'

export function PromptChanges(props: { item: Item }) {
	let changes = () => promptChanges.rows(props.item)
	return (
		<div class="PromptChanges content diff change">
			<For each={changes().slice(1)}>
				{(r) => (
					<div class={`row ${r.tone}`}>
						{r.parts ? (
							<For each={r.parts}>
								{(w, k) => (
									<>
										{k() ? ' ' : ''}
										<span class={w.tone}>{w.text}</span>
									</>
								)}
							</For>
						) : (
							r.text
						)}
					</div>
				)}
			</For>
			<For each={promptChanges.run(props.item)}>
				{(o) => (
					<>
						<div class="head">{promptChanges.line(o)}</div>
						<div class="lines">
							<For each={o.change!.diff.split('\n')}>{(r) => <div class={diff.tone(r)}>{r}</div>}</For>
						</div>
					</>
				)}
			</For>
		</div>
	)
}
