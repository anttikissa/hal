# Plan: Cross-Terminal Key Tests + Capability Docs

## Goal

1. Extend `tui-keyboard.test.ts` to test all 4 terminal fixtures (Ghostty, Kitty, iTerm, Apple Terminal)
2. Create `docs/terminal-keys.md` summarizing per-terminal capabilities and quirks

## Fixtures

- `keys-ghostty.ason` — Ghostty (kitty protocol, 43 steps)
- `keys-xterm-kitty.ason` — Kitty (kitty protocol, 42 steps)
- `keys-iterm-app.ason` — iTerm (kitty protocol, 25 captured)
- `keys-apple-terminal.ason` — Apple Terminal (legacy only, 24 captured)

All use the `hal11` profile (kitty keyboard mode `>11u`).

## Test structure

### Existing (keep)
- Ghostty-specific baseline tests (fixture load, parseKeys tokenization, normalization regressions)
- CSI-u parsing unit tests
- Functional key normalization unit tests

### New: cross-terminal describe block
For each fixture, run:
1. **parseKeys round-trip**: verify `parseKeys(bytesToRaw(step.bytes))` tokenizes to the same hex tokens as the fixture
2. **Normalization convergence**: for keys that should normalize identically across all kitty-capable terminals (Ghostty, Kitty, iTerm), verify they produce the same result
3. **Apple Terminal legacy**: verify Apple Terminal legacy sequences produce expected results through the normalizer (passthrough since no kitty protocol)

### Key convergence expectations (kitty-capable terminals)
These should normalize identically:
- Basic: a, space, enter, tab, backspace, esc
- Navigation: arrows, shift+arrows, delete
- Modifiers: ctrl_c, ctrl_z, alt_1, shift_enter, shift_tab
- Cmd: cmd_v_known (paste text), cmd_x

### Known divergences to document (not test failures)
- `A` (Shift-A): kitty protocol sends codepoint 97 + shift + associated text; normalizer returns `a`. Apple sends `A`. Both correct.
- `alt_left`/`alt_right`: Ghostty → ESCb/ESCf, Kitty → ESC[1;3D/ESC[1;3C, iTerm → broken ESC ESC[D. Apple → ESCb/ESCf.
- `cmd_a`/`cmd_z`: Ghostty suppresses key event (only Super press/release), Kitty sends full CSI-u. iTerm/Apple → empty (OS intercept).
- `shift_up`/`shift_down`: Apple Terminal doesn't distinguish from plain arrows.

## Docs structure (`docs/terminal-keys.md`)
- Overview table: terminal × feature support
- Per-terminal quirks
- Normalization summary: what HAL's normalizer produces for each key family
- Known issues / TODO
