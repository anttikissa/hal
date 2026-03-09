# CLI Blocks

## Design

```
Tab { blocks: Block[] }  →  renderBlocks(width) → string[]  →  diff renderer
```

Container joins block outputs with exactly one blank line between them.
Each block's render() collapses its own consecutive blank lines.

### Block types

```typescript
type Block =
    | { type: 'input'; text: string; source?: string; status?: 'queued' | 'steering' }
    | { type: 'assistant'; text: string; done: boolean }
    | { type: 'thinking'; text: string; done: boolean }
    | { type: 'tool'; name: string; status: 'streaming' | 'running' | 'done' | 'error';
        args: string; output: string; startTime: number }
```

### What changes

- `cli-tabs.ts`: Tab gets `blocks: Block[]` instead of `lines: string[]`
- New `cli-blocks.ts`: Block types + renderBlocks()
- `cli.ts`: buildLines() calls renderBlocks()
