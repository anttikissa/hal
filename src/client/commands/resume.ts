// /resume: reopens the last closed tab.

import { app } from '../app.ts'

export const command = { run: (): void => app.send({ type: 'tab-resume' }) }
