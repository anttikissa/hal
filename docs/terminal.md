# Terminal Rendering Rules

Requirements for anyone who touches terminal code.
Implementation: `src/client/render.ts`. Keep this file in sync with that.

## 1. Don't clear the screen on start

The CLI must not clear the screen or start rendering from the top. It must behave like any well-behaved terminal REPL (perl, node, etc.) — output starts at the current cursor position and flows downward.

The difference is that hal re-renders its last N lines on every update (for text editing, tab switching, streaming). But the content above the current "frame" is ordinary terminal scrollback.

## 2. Stable prompt position across tab switches

When tabs are shorter than the visible content area, keep the input area at the same row by tracking the tallest tab. If the current tab is shorter than that shared height, put the blank padding above its content, not below it. That keeps the tab's visible lines attached to the prompt in shorter terminals instead of pushing them off-screen.

Do not let that shared height grow past the visible content area of the terminal. Once another tab is taller than the viewport, extra blank padding would only pollute scrollback with empty lines. Cap the padding to the visible content area instead.

## 3. Full-height optimization

Once any tab fills the visible content area, all tabs are effectively full-height for prompt positioning. Older content can scroll, but background-tab growth must not inject extra blank lines into terminal history.

## 4. Quit should preserve the last frame

On normal quit (for example Ctrl-C), keep the last rendered tab content visible in the terminal for copy/paste and review. Do not clear the screen, switch to an alternate screen buffer, or emit teardown sequences that wipe the visible frame on exit.
