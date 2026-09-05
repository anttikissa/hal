import { createHash } from 'crypto'
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { ason } from '../utils/ason.ts'
import { log } from '../utils/log.ts'
import { STATE_DIR } from './state.ts'

export type SubscriptionProvider = 'openai' | 'anthropic'

export interface SubscriptionWindow {
	label: string
	durationMinutes: number
	usedPercent: number
	resetAt?: number
}

const state = {
	path: `${STATE_DIR}/subscription-usage.asonl`,
}

const io = {
	now: (): string => new Date().toISOString(),
	append: (path: string, text: string): void => {
		mkdirSync(dirname(path), { recursive: true })
		appendFileSync(path, text)
	},
}

/** Auth account keys may contain an email or provider account ID, but never a token. */
function accountPseudonym(provider: SubscriptionProvider, accountKey: string): string {
	return createHash('sha256').update(provider).update('\0').update(accountKey).digest('hex')
}

function sameWindows(a: SubscriptionWindow[] | undefined, b: SubscriptionWindow[]): boolean {
	if (!a || a.length !== b.length) return false
	for (let index = 0; index < a.length; index++) {
		const left = a[index]!
		const right = b[index]!
		if (left.label !== right.label
			|| left.durationMinutes !== right.durationMinutes
			|| left.usedPercent !== right.usedPercent
			|| left.resetAt !== right.resetAt) return false
	}
	return true
}

function observe(provider: SubscriptionProvider, accountKey: string, windows: SubscriptionWindow[], previous?: SubscriptionWindow[]): void {
	if (!accountKey || windows.length === 0 || subscriptionLog.sameWindows(previous, windows)) return
	const record = {
		ts: subscriptionLog.io.now(),
		provider,
		account: subscriptionLog.accountPseudonym(provider, accountKey),
		windows,
	}
	try {
		subscriptionLog.io.append(subscriptionLog.state.path, `${ason.stringify(record, 'short')}\n`)
	} catch (error) {
		log.error('Failed to write subscription usage observation', {
			provider,
			message: error instanceof Error ? error.message : String(error),
		})
	}
}

export const subscriptionLog = { state, io, accountPseudonym, sameWindows, observe }
