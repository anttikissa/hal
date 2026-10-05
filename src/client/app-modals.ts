// The terminal's modals: open and close one, and the model picker and
// /config modal the host's events open.

import type { ModalState } from '../common/modals.ts'
import { picker } from '../common/picker.ts'
import type { Event } from '../common/protocol.ts'
import { settingsModal } from '../common/settings-modal.ts'
import { app, type AppState } from './app.ts'
import { find } from './find.ts'

// Opens `modal` over everything. Enter closes it and sends what
// `submit` makes of it (nothing if undefined); Escape just closes it.
function open(modal: ModalState, submit: NonNullable<AppState['onModal']>, onKey?: AppState['onModalKey']): void {
	app.state.modal = modal
	app.state.onModal = submit
	if (onKey) app.state.onModalKey = onKey
	else delete app.state.onModalKey
	app.show()
}

function close(): void {
	if (app.state.modal?.find) find.close()
	delete app.state.modal
	delete app.state.onModal
	delete app.state.onModalKey
	app.show()
}

// The host's model list: the picker for this session, if it is on screen.
function pick(event: Event & { type: 'models' }): void {
	if (app.state.transcript?.meta.id !== event.sessionId) return
	if (event.refresh && !app.state.modal?.tree) return
	let id = event.sessionId
	app.open(
		event.refresh ? picker.refresh(app.state.modal!, event.items, event.names, event.capabilities) : picker.open(event.current, event.items, event.names, event.capabilities, event.effort),
		(action, modal) => picker.command(id, modal, action),
		(modal, key) => picker.step(modal, key, event.items, event.names),
	)
}

// The /config modal for the session on screen, or an update of it.
function configure(event: Event & { type: 'settings' }): void {
	let modal = app.state.modal, id = app.state.transcript?.meta.id
	if (event.refresh) return modal?.settings ? ((app.state.modal = settingsModal.refresh(modal, event)), app.show()) : undefined
	if (id && event.sessionId === id) app.open(settingsModal.open(event), () => undefined, (m, key) => settingsModal.step(m, key, id))
}

export const appModals = { open, close, pick, configure }
