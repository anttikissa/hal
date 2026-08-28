// Block sizing/limits shared by block-data.ts (blob loading) and the terminal
// block renderers (blocks.ts, tool-specs.ts). It lives in its own module so
// those can all read the same `blocks` config keys without importing each
// other, which previously made them circular.

const config = {
	tabWidth: 4,
	blobBatchSize: 64,
	maxToolTextRows: 8,
	maxEditDiffLines: 3,
}

export const blockConfig = { config }
