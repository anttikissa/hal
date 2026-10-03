/// <reference lib="dom" />
// Two stable overview lines; native modal details retain every pushed fact.
// The full cwd truncates from the start; wide layouts also show the session
// id and usage windows. The model name doubles as quota left (task 5f).
import { For } from 'solid-js'
import { names } from '../../common/names.ts'
import { titles } from '../../common/titles.ts'
import { view, type ViewState } from '../view.ts'
import { status, type StatusGroup } from '../status.ts'

const heat = (n: number | undefined) => (n === undefined ? '' : `heat-${n}`)

function Parts(props: { group: StatusGroup }) {
	return <span dir="ltr"><For each={props.group.parts}>{(part) => <span class={heat(part.heat)}>{part.text}</span>}</For></span>
}

export function StatusRow(props: { view: ViewState; connected: boolean; color?: number }) {
	let details!: HTMLDialogElement
	let meta = () => props.view.transcript?.meta
	let line = () => view.line(props.view, props.connected)
	let tone = () => ({ idle: '', busy: 'busy', warn: 'warning', error: 'error' })[line().tone]
	let context = () => status.context(props.view)
	let quota = () => status.quota(props.view)
	let windows = () => status.windows(props.view)
	// Window names are strings, so their nodes survive every push.
	let names_ = () => windows().map((w) => w.name)
	let win = (name: string) => windows().find((w) => w.name === name)
	// Which subscription the windows belong to, as /status numbers its slots.
	let slot = () => { let p = props.view.transcript?.stats?.plan; return p && p.accounts > 1 ? `${p.account}/${p.accounts} ` : '' }
	let cwd = () => meta()?.cwd.replace(/(.)\/+$/, '$1') ?? ''
	let outside = (e: MouseEvent) => {
		let r = details.getBoundingClientRect()
		if (e.target === details && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) details.close()
	}
	return (
		<div class="StatusRow status" aria-label="Session status">
			<button type="button" class="overview" aria-label="Session details" aria-describedby="status-quota" aria-haspopup="dialog" onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }} onClick={() => details.showModal()}>
				<span class="primary">
					<span class="name"><span class="id">{meta() ? `${meta()!.id}: ` : ''}</span>{meta()?.name ?? (meta() ? names.fallback(meta()!.id) : 'Connecting')}</span>
					<span class={['activity', tone()]} aria-live="polite"><span class={['dot', tone()]} aria-hidden="true">●</span> {line().text}</span>
					<span class={heat(context()?.heat)}>{context()?.text}</span>
					<span aria-hidden="true">▾</span>
				</span>
				<span class="secondary">
					<span class="cwd" style={props.color === undefined ? undefined : { '--project': `var(--p${props.color})` }}><bdi>{cwd()}</bdi></span>
					<span class={['model', quota() && 'quota', heat(quota()?.used)]} style={{ '--fill': `${quota()?.remaining ?? 0}%` }}>{meta() ? titles.modelName(meta()!.model) : ''}</span>
					<span class="windows" aria-hidden="true">{slot()}<For each={names_()}>{(name) => (
						<span class={['window', heat(win(name)?.used)]}>
							{name} <span class="bar"><span style={{ width: `${win(name)?.used ?? 0}%` }} /></span> {win(name)?.used}% used<span class="reset">{win(name)?.resets ? ` (resets ${status.reset(win(name)!.resets!)})` : ''}</span>
						</span>
					)}</For></span>
				</span>
				<span id="status-quota" class="hidden-text">{quota() ? `${quota()!.window} quota ${quota()!.remaining}% remaining` : ''}</span>
			</button>
			<dialog ref={(e) => (details = e)} class="StatusDetails" aria-label="Session details" onClick={outside} onKeyDown={(e) => e.stopPropagation()}>
				<div class="top"><strong>Session details</strong><button type="button" aria-label="Close session details" onClick={() => details.close()}>✕</button></div>
				<p class={tone()}>{line().text}</p>
				<For each={status.groups(props.view)}>{(group) => <div class="fact">
					{group.href ? <a href={group.href}><Parts group={group} /></a> : <Parts group={group} />}
				</div>}</For>
			</dialog>
		</div>
	)
}
