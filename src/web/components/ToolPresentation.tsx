/// <reference lib="dom" />
import { For, Show } from 'solid-js'
import { toolPresentation, type ToolPresentation as Presentation } from '../../common/tool-presentation.ts'
import { diff } from '../../common/diff.ts'

export function ToolPresentation(props: { presentation: Presentation; output?: string }) {
	return <div class="ToolPresentation"><For each={props.presentation.blocks}>{(block) => <section>
		<Show when={block.path}>{(path) => <div class="path">{path()}</div>}</Show>
		<Show when={block.kind === 'diff'} fallback={<pre><code>{toolPresentation.text(block, props.output)}</code></pre>}>
			<div class="diff"><For each={toolPresentation.text(block, props.output).split('\n')}>{(line) => <div class={diff.tone(line)}>{line || '\u00a0'}</div>}</For></div>
		</Show>
	</section>}</For></div>
}
