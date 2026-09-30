/// <reference lib="dom" />
// Two stable overview lines; native modal details retain every pushed fact.
import { For } from 'solid-js'
import { names } from '../../common/names.ts'
import { titles } from '../../common/titles.ts'
import { view, type StatusGroup, type ViewState } from '../view.ts'

function Parts(props: { group: StatusGroup }) {
	return <span dir="ltr"><For each={props.group.parts}>{(part) => <span class={part.heat ? `status-${part.heat}` : ''}>{part.text}</span>}</For></span>
}

export function StatusRow(props: { view: ViewState; connected: boolean }) {
	let details!: HTMLDialogElement
	let meta = () => props.view.transcript?.meta
	let line = () => view.line(props.view, props.connected)
	let tone = () => ({ idle: '', busy: 'busy', warn: 'warning', error: 'error' })[line().tone]
	let context = () => view.context(props.view)
	let outside = (e: MouseEvent) => {
		let r = details.getBoundingClientRect()
		if (e.target === details && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) details.close()
	}
	return (
		<div class="StatusRow status" aria-label="Session status">
			<button type="button" class="overview" aria-label="Session details" aria-haspopup="dialog" onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }} onClick={() => details.showModal()}>
				<span class="primary">
					<span class="name">{meta()?.name ?? (meta() ? names.fallback(meta()!.id) : 'Connecting')}</span>
					<span class={['activity', tone()]} aria-live="polite"><span class={['dot', tone()]} aria-hidden="true">●</span> {line().text}</span>
					<span class={context()?.heat ? `status-${context()!.heat}` : ''}>{context()?.text}</span>
					<span aria-hidden="true">▾</span>
				</span>
				<span class="secondary">
					<span class="cwd">{meta()?.cwd.replace(/\/+$/, '').split('/').at(-1) || '/'}</span>
					<span class="model">{meta() ? titles.modelName(meta()!.model) : ''}</span>
				</span>
			</button>
			<dialog ref={(e) => (details = e)} class="StatusDetails" aria-label="Session details" onClick={outside} onKeyDown={(e) => e.stopPropagation()}>
				<div class="top"><strong>Session details</strong><button type="button" aria-label="Close session details" onClick={() => details.close()}>✕</button></div>
				<p class={tone()}>{line().text}</p>
				<For each={view.status(props.view)}>{(group) => <div class="fact">
					{group.href ? <a href={group.href}><Parts group={group} /></a> : <Parts group={group} />}
				</div>}</For>
			</dialog>
		</div>
	)
}
