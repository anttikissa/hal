// /redraw: repaints everything, whatever has the keys.

import { render } from '../render.ts'

export const command = { run: (): void => render.request('Ctrl-L or /redraw') }
