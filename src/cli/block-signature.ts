import type { Block } from './blocks.ts'

function mix(hash: number, value: number): number {
	return Math.imul(hash ^ value, 16777619) >>> 0
}

function textSignature(text: string): number {
	const len = text.length
	if (len === 0) return 0
	let hash = len >>> 0
	hash = mix(hash, text.charCodeAt(0))
	hash = mix(hash, text.charCodeAt(len - 1))
	hash = mix(hash, text.charCodeAt(Math.floor(len / 2)))
	return hash
}

function blockTypeCode(block: Block): number {
	switch (block.type) {
		case 'input': return 1
		case 'assistant': return 2
		case 'thinking': return 3
		case 'info': return 4
		case 'error': return 5
		case 'tool': return 6
	}
}

function toolStatusCode(status: Extract<Block, { type: 'tool' }>['status']): number {
	switch (status) {
		case 'streaming': return 1
		case 'running': return 2
		case 'done': return 3
		case 'error': return 4
	}
}

function blockSignature(block: Block): number {
	let hash = blockTypeCode(block)
	switch (block.type) {
		case 'input':
			hash = mix(hash, textSignature(block.text))
			hash = mix(hash, textSignature(block.model ?? ''))
			hash = mix(hash, textSignature(block.status ?? ''))
			return hash
		case 'assistant':
			hash = mix(hash, textSignature(block.text))
			hash = mix(hash, block.done ? 1 : 0)
			hash = mix(hash, textSignature(block.model ?? ''))
			return hash
		case 'thinking':
			hash = mix(hash, textSignature(block.text))
			hash = mix(hash, block.done ? 1 : 0)
			hash = mix(hash, textSignature(block.model ?? ''))
			hash = mix(hash, textSignature(block.blobId ?? ''))
			return hash
		case 'info':
			return mix(hash, textSignature(block.text))
		case 'error':
			hash = mix(hash, textSignature(block.text))
			hash = mix(hash, textSignature(block.detail ?? ''))
			hash = mix(hash, textSignature(block.blobId ?? ''))
			return hash
		case 'tool':
			hash = mix(hash, textSignature(block.name))
			hash = mix(hash, toolStatusCode(block.status))
			hash = mix(hash, textSignature(block.args))
			hash = mix(hash, textSignature(block.output))
			hash = mix(hash, textSignature(block.blobId ?? ''))
			return hash
	}
}

export function blocksSignature(blocks: Block[]): number {
	let hash = 2166136261
	hash = mix(hash, blocks.length)
	for (const block of blocks) hash = mix(hash, blockSignature(block))
	return hash
}

export const blockSignatureUtil = { blocksSignature }
