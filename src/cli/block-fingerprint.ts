import type { Block } from './blocks.ts'

/* Fingerprint exists to avoid re-rendering every block on each prompt keystroke: we hash the
   fields that affect visible block output into a fast non-cryptographic number, and when the
   session, width, cursor visibility, and fingerprint are unchanged we reuse cached rendered
   lines instead of recomputing them; this is strictly a UI cache key (collisions possible)
   and not for security, identity, or persistence. */

function mix(hash: number, value: number): number {
	return Math.imul(hash ^ value, 16777619) >>> 0
}

function textFingerprint(text: string): number {
	let hash = 2166136261
	hash = mix(hash, text.length)
	for (let i = 0; i < text.length; i++) hash = mix(hash, text.charCodeAt(i))
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

function blockFingerprint(block: Block): number {
	let hash = blockTypeCode(block)
	switch (block.type) {
		case 'input':
			hash = mix(hash, textFingerprint(block.text))
			hash = mix(hash, textFingerprint(block.model ?? ''))
			hash = mix(hash, textFingerprint(block.status ?? ''))
			return hash
		case 'assistant':
			hash = mix(hash, textFingerprint(block.text))
			hash = mix(hash, block.done ? 1 : 0)
			hash = mix(hash, textFingerprint(block.model ?? ''))
			return hash
		case 'thinking':
			hash = mix(hash, textFingerprint(block.text))
			hash = mix(hash, block.done ? 1 : 0)
			hash = mix(hash, textFingerprint(block.model ?? ''))
			hash = mix(hash, textFingerprint(block.blobId ?? ''))
			return hash
		case 'info':
			return mix(hash, textFingerprint(block.text))
		case 'error':
			hash = mix(hash, textFingerprint(block.text))
			hash = mix(hash, textFingerprint(block.detail ?? ''))
			hash = mix(hash, textFingerprint(block.blobId ?? ''))
			return hash
		case 'tool':
			hash = mix(hash, textFingerprint(block.name))
			hash = mix(hash, toolStatusCode(block.status))
			hash = mix(hash, textFingerprint(block.args))
			hash = mix(hash, textFingerprint(block.output))
			hash = mix(hash, textFingerprint(block.blobId ?? ''))
			return hash
	}
}

export function blocksFingerprint(blocks: Block[]): number {
	let hash = 2166136261
	hash = mix(hash, blocks.length)
	for (const block of blocks) hash = mix(hash, blockFingerprint(block))
	return hash
}

export const blockFingerprintUtil = { blocksFingerprint }
