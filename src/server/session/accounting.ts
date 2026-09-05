import type { PartialTokenUsage } from '../../common/protocol.ts'
import type { UsageReceipt } from '../../common/history.ts'
import { models } from '../../common/models.ts'
import { sessions } from '../sessions.ts'

function start(model: string, purpose: UsageReceipt['purpose']) {
	return { model, purpose, startedAt: Date.now(), requests: 0, reported: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } }
}

type Meter = ReturnType<typeof start>

function add(meter: Meter, usage: PartialTokenUsage): void {
	meter.reported++
	meter.usage.input += usage.input
	meter.usage.output += usage.output
	meter.usage.cacheRead += usage.cacheRead ?? 0
	meter.usage.cacheCreation += usage.cacheCreation ?? 0
}

function save(sessionId: string, meter: Meter): void {
	if (!meter.requests || meter.model.startsWith('hal/')) return
	const receipt: UsageReceipt = {
		type: 'usage', model: meter.model, purpose: meter.purpose,
		requests: meter.requests, usage: meter.usage,
		ts: new Date().toISOString(), durationMs: Date.now() - meter.startedAt,
	}
	if (meter.reported < meter.requests) receipt.incomplete = true
	// Persist the estimate now, so later price changes cannot rewrite past costs.
	// Unknown prices stay absent; partial usage produces a partial cost estimate.
	if (meter.reported && models.pricing(meter.model)) receipt.apiUsd = models.computeCost(meter.model, meter.usage)
	sessions.appendHistory(sessionId, [receipt])
}

export const accounting = { start, add, save }
