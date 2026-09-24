import { createSignal, For, onSettled, Show } from 'solid-js'
import { render } from '@solidjs/web'

const kinds = ['assistant', 'thinking', 'tool'] as const
type Block = { id: string; kind: (typeof kinds)[number]; updates: number }

function BlockCard(props: { block: Block }) {
	const [open, setOpen] = createSignal(false)
	return <article class={props.block.kind}>
		<button type="button" aria-expanded={open() ? 'true' : 'false'} onClick={() => setOpen(!open())}>
			<span>{open() ? '▾' : '▸'} {props.block.kind} <small>{props.block.id}</small></span>
			<span class="state">{open() ? 'Open' : 'Closed'}</span>
		</button>
		<Show when={open()}><div class="contents">This card stays open while new blocks arrive.<br />Data updates received: {props.block.updates}</div></Show>
	</article>
}

function Demo() {
	const [blocks, setBlocks] = createSignal<Block[]>([
		{ id: '000001-vw7', kind: 'assistant', updates: 0 },
		{ id: '000002-q4k', kind: 'thinking', updates: 0 },
		{ id: '000003-pku', kind: 'tool', updates: 0 },
	])
	onSettled(() => {
		const timer = window.setInterval(() => setBlocks((previous) => {
			// Simulate full server snapshots: even unchanged blocks get NEW objects.
			const next: Block[] = []
			for (const block of previous) next.push({ ...block, updates: block.updates + 1 })
			const number = next.length + 1
			next.push({ id: `${String(number).padStart(6, '0')}-pku`, kind: kinds[(number - 1) % kinds.length]!, updates: 0 })
			return next
		}), 2_000)
		return () => window.clearInterval(timer)
	})
	return <>
		<style>{`
			* { box-sizing: border-box; }
			body { margin: 0; background: #111719; color: #e5edf0; font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
			main { width: min(100% - 32px, 740px); margin: 40px auto; }
			h1 { font-size: 1.3rem; margin-bottom: 4px; }
			p { color: #acc3cc; margin: 0 0 24px; }
			article { margin: 10px 0; background: #182729; border: 1px solid #315257; border-left: 4px solid #75cecb; border-radius: 4px; }
			article.thinking { border-left-color: #bca7de; }
			article.tool { border-left-color: #edb770; }
			button { display: flex; justify-content: space-between; gap: 12px; width: 100%; padding: 13px; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
			button:focus-visible { outline: 2px solid #8fc5ed; outline-offset: 2px; }
			small, .state { color: #acc3cc; }
			.contents { padding: 0 13px 13px; color: #c4d6df; }
		`}</style>
		<main><h1>Block identity experiment</h1>
			<p>Every 2 seconds: clone every block, update its data, and append one. Open any card; it should stay open.</p>
			<For each={blocks()} keyed={(block) => block.id}>
				{(block) => <BlockCard block={block()} />}
			</For>
		</main>
	</>
}

render(() => <Demo />, document.querySelector('#app')!)
