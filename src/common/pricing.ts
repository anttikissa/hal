// USD per million tokens, as listed by the model catalog (task asa).
export type Pricing = { input: number; output: number; cacheRead?: number; cacheWrite?: number }
export const pricing = {
	cost(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }, prices: Pricing): number | undefined {
		let total = 0
		for (let key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
			let count = usage[key] ?? 0
			if (!Number.isFinite(count) || count < 0) throw new Error(`invalid ${key} token count: ${count}`)
			if (!count) continue
			let price = prices[key]
			if (price === undefined) return undefined
			if (!Number.isFinite(price) || price < 0) throw new Error(`invalid ${key} price: ${price}`)
			total += count * price / 1_000_000
		}
		return total
	},
}
