# Terminal Key Sequences

Captured key behavior across 4 macOS terminals with HAL's `hal11` profile
(kitty keyboard protocol `>11u`). Data from `src/tests/fixtures/keys/`.

## Terminals tested

| Terminal | Version | Kitty protocol | Capture file |
|---|---|---|---|
| Ghostty | latest | ✓ full | `keys-ghostty.ason` |
| Kitty | latest | ✓ full | `keys-xterm-kitty.ason` |
| iTerm2 | 3.6.6 | ✓ partial | `keys-iterm-app.ason` |
| Apple Terminal | 453 | ✗ legacy only | `keys-apple-terminal.ason` |

## Feature support matrix

| Feature | Ghostty | Kitty | iTerm | Apple Terminal |
|---|---|---|---|---|
| CSI-u key encoding | ✓ | ✓ | ✓ | ✗ |
| Press/release events | ✓ | ✓ | ✓ | ✗ |
| Associated text (flag 16) | ✓ | ✓ | ✓ | ✗ |
| Modifier key events (Shift/Ctrl/Alt/Super) | ✓ | ✓ | ✓ | ✗ |
| Cmd/Super key forwarding | partial | ✓ | ✗ (OS intercept) | ✗ |
| Shift+Up/Down distinct from plain | ✓ | ✓ | ✓ | ✗ |
| Shift-Tab as CSI-u | ✓ | ✓ | ✓ | ✗ (sends ESC[Z) |

## Normalization convergence

Keys that HAL normalizes to the **same** output across all kitty-capable terminals
(Ghostty, Kitty, iTerm):

| Key | Normalized |
|---|---|
| a | `a` |
| Space | ` ` |
| Enter | `\r` |
| Tab | `\t` |
| Backspace | `\x7f` |
| Esc | `\x1b` |
| Delete | `ESC[3~` |
| ↑ ↓ ← → | `ESC[A` `ESC[B` `ESC[D` `ESC[C` |
| Shift+← → | `ESC[1;2D` `ESC[1;2C` |
| Shift+↑ ↓ | `ESC[1;2A` `ESC[1;2B` |
| Shift+Enter | `ESC[13;2u` |
| Shift+Tab | `ESC[9;2u` |
| Ctrl-C | `\x03` |
| Ctrl-Z | `\x1a` |
| Alt-1 | `ESC1` |
| Cmd-V (clipboard) | pasted text characters |

Apple Terminal produces identical results for basic keys, arrows, Ctrl-C/Z, Alt-1,
and Cmd-V clipboard. Differs where noted below.

## Known divergences

### Shift-A

| Terminal | Raw | Normalized |
|---|---|---|
| Ghostty/Kitty/iTerm | `ESC[97;2u` (codepoint 97 + shift) | `a` |
| Apple Terminal | `A` (0x41) | `A` |

Kitty protocol sends the base codepoint with shift modifier; normalizer returns
the associated text or base character. Apple sends the shifted character directly.

**Impact**: None for text input (both produce the correct character in practice
because Shift-A insertion uses the associated text field). The test documents the
difference.

### Alt+Left / Alt+Right (Option word-motion)

| Terminal | Alt+Left raw | Normalized |
|---|---|---|
| Ghostty | `ESC[57443;3u` `ESCb` release… | `ESCb` ✓ |
| Kitty | `ESC[57443;3u` `ESC[1;3D` release… | `ESC[1;3D` |
| iTerm | `ESC[57443;3u` `ESC` `ESC[D` release… | `ESC-ESC`, `[`, `D` ✗ |
| Apple Terminal | `ESCb` | `ESCb` ✓ |

- **Ghostty** sends `ESCb`/`ESCf` (readline word-motion) inside the kitty envelope.
- **Kitty** sends `ESC[1;3D`/`ESC[1;3C` (standard Alt+Arrow CSI). Functional but
  not handled as word-motion by HAL — needs explicit mapping.
- **iTerm** sends `ESC ESC[D` — a raw ESC byte followed by legacy `ESC[D`. The parser
  sees the double-ESC as an Alt-Escape pair, then `[` and `D` as separate characters.
  **This is a known bug** (iTerm quirk + parser limitation).
- **Apple Terminal** sends `ESCb`/`ESCf` directly.

**TODO**: Map `ESC[1;3D`→word-left and `ESC[1;3C`→word-right in the key handler
to fix Kitty. Fix iTerm double-ESC tokenization or add a special case.

### Shift+Up / Shift+Down

| Terminal | Shift+Up | Normalized |
|---|---|---|
| Ghostty/Kitty/iTerm | `ESC[1;2:1A` | `ESC[1;2A` |
| Apple Terminal | `ESC[A` | `ESC[A` |

Apple Terminal doesn't distinguish Shift+Up/Down from plain Up/Down.

### Shift-Tab

| Terminal | Raw | Normalized |
|---|---|---|
| Ghostty/Kitty/iTerm | `ESC[9;2u` | `ESC[9;2u` |
| Apple Terminal | `ESC[Z` | `ESC[Z` |

HAL handles both forms in its key handler.

### Cmd shortcuts (Cmd-A, Cmd-X, Cmd-Z)

| Terminal | Cmd-A | Cmd-X | Cmd-Z |
|---|---|---|---|
| Ghostty | `[]` (Super press/release only) | `ESC[120;9u` | `[]` |
| Kitty | `ESC[97;9u` | `ESC[120;9u` | `ESC[122;9u` |
| iTerm | empty (OS intercept) | empty | empty |
| Apple Terminal | empty (OS intercept) | empty | empty |

- **Ghostty** suppresses most Cmd combos (only Super modifier key events are sent),
  but forwards Cmd-X.
- **Kitty** forwards all Cmd combos as CSI-u with Super modifier (bit 8).
- **iTerm/Apple Terminal** let macOS handle Cmd shortcuts; the terminal receives nothing.

### Cmd-V (paste)

| Terminal | Empty clipboard | With clipboard text |
|---|---|---|
| Ghostty | `[]` (Super only) | Pasted text as characters |
| Kitty | `[]` (Super only) | Pasted text as characters |
| iTerm | empty | Pasted text as characters |
| Apple Terminal | empty | Pasted text as characters |

All terminals deliver clipboard content as character input when Cmd-V is pressed
with text on the clipboard. The pasted text arrives between the Super press and
release events (Ghostty/Kitty) or directly (iTerm/Apple).

## Capture methodology

Sequences captured with `bun scripts/capture.ts` using the `tui` preset.
Each step sends an enable sequence (`ESC[>11u`), waits for the target key,
then sends a disable sequence (`ESC[<u`). Steps are delimited by Esc keypress
or timeout.

To re-capture a single step: `bun scripts/capture.ts --step <id>`

To re-capture all: `bun scripts/capture.ts`
