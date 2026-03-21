# Terminal Rendering Rules

Requirements for anyone who touches terminal code.
Implementation: `src/client/render.ts`. Keep this file in sync with that.

## 1. Don't clear the screen on start

The CLI must not clear the screen or start rendering from the top. It must behave like any well-behaved terminal REPL (perl, node, etc.) — output starts at the current cursor position and flows downward.

The difference is that hal re-renders its last N lines on every update (for text editing, tab switching, streaming). But the content above the current "frame" is ordinary terminal scrollback.

## 2. Stable prompt position across tab switches

When switching tabs, the input area must stay at the exact same row. This means we need to track the height of the tallest tab, even if it's not the current one. Incoming blocks on background tabs must contribute to height tracking.

If the current tab is shorter than that shared height, put the blank padding above its content, not below it. That keeps the tab's visible lines attached to the prompt in shorter terminals instead of pushing them off-screen.
## 3. Full-height optimization

Once any tab fills the full terminal height, all tabs are effectively full-height and we no longer need to track the tallest tab. This happens quickly in practice — users will have many tabs with many blocks.

Whether to optimize based on this is a judgment call. Keeping the code minimal and simple takes priority over optimizing for edge cases.
