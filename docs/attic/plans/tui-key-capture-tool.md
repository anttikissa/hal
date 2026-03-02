# TUI Key Capture Tool Plan

Date: 2026-02-25
Scope: Add an interactive key-sequence capture script for collecting real terminal outputs (Kitty, Ghostty, iTerm, Terminal.app) to drive TUI keyboard tests.

## Goals

- Capture raw terminal bytes for a comprehensive set of TUI-relevant keys and modifier combos
- Support multiple terminal mode profiles in one run (`raw`, HAL Kitty mode, optional Kitty 31)
- Produce machine-readable ASON output for later fixture/test generation
- Make the capture flow reliable for keys that terminals/OS may intercept (record empty output instead of hanging)

## Design

1. Guided interactive script: `scripts/capture.ts`
2. Raw mode on stdin; no build step (Bun/TS)
3. Per-profile terminal mode toggles (Kitty keyboard protocol on/off)
4. Esc calibration per profile, then delimiter-based capture (`target` + calibrated `Esc`)
5. Built-in step presets (`smoke`, `tui`, `full`) with TUI-relevant keys
6. Output file in ASON with terminal env metadata + profile runs + step results + matrix summary

## Output Shape (high level)

- terminal metadata (TERM, TERM_PROGRAM, platform)
- capture config (preset, settle/timeout)
- profiles[]
  - profile mode info
  - calibrated Esc sentinel
  - step results (raw bytes, display text, tokenized view, timeout/empty/captured status)
- matrix (step id -> profile id -> summary)

## Validation

- `bun scripts/capture.ts --help`
- `bun scripts/capture.ts --list-steps --preset tui`
- `bun run test:quick`

## Follow-up

- Use captured files to generate deterministic TUI keyboard fixtures/tests
- Add targeted tests for Kitty/Ghostty `CSI u` variants observed in the captures
