// Character estimates share the same ratio on every surface (task 1dk).
import type { Message } from './blocks.ts'

function estimate(characters: number, model?: string, ratios: Record<string, number> = {}): number {
	let ratio = model && Object.hasOwn(ratios, model) ? ratios[model]! : tokenEstimates.defaultRatio
	return Math.ceil(Math.max(0, characters) / ratio)
}

function characters(messages: Message[], overhead = 0): number {
	return JSON.stringify(messages).length + overhead
}

export const tokenEstimates = { estimate, characters, defaultRatio: 3 }
