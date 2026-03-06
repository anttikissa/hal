# TODO

## REAL TODO

- Restore -> resume (same terminology as codex cli)
- Style tool blocks and all other blocks well
- Esc and Ctrl-C and Ctrl-D should work better - maybe a debug thing to restart?
- Add stuff here



## NICE TO HAVE

- Copy from output inserts fake newlines at word-wrap boundaries (visual rows joined with \n instead of recognizing they belong to the same logical line)
- Copy from output loses original tabs (expanded to spaces at storage time for correct mouse click mapping; could preserve originals via visual→logical line mapping)
- 


## BELOW THIS - OLD STUFF





## Do next:

### UI has:

1. **Title bar** — background-styled, shows topic + session context
2. **Output viewport** — scrollable, word-wrapped, ANSI-aware
3. **Activity line** — dim (`  Model: Done.` / `  Model: ...` with model label)
4. **Status line** — tabs on left, context on right (`[1 .hal] 2 .config  ...  owner · 36.9%/200k`)
5. **Prompt area** — dark grey background, `> ` prefix, 1-col side padding

### UI work:

DONE - Prompt echo is now grey on every line (formatText API with horizontal padding)

DONE - Tool output styling now applies to every line, not just first 2 (applyStylePerLine for all output types)

DONE - Bright word seams in list output fixed (chunk stability + per-line style application)

DONE - Prompt echo initial words brighter than rest — fixed by same per-line styling

Still open:
- Tab activity indicators (!, ?, *, checkmark for done, X for error) — not yet implemented
- Write tool EISDIR error when given directory path — now fixed with directory check

### END UI WORK


- When I restart the app, I need to see past messages. Whether the app is client, or owner. This sometimes happens but sometimes it's buggy

- Architect commands vs keybindings so they can't diverge: every keybinding should call the same function as its corresponding slash command. Audit all pairs (ctrl-w / /close, ctrl-t / /new, etc.) and make the architecture obvious enough that dumb models won't re-introduce duplicate code paths.
- System.md analysis and revamp - what to add/remove - also better <if> for codex
- Fix Codex by better prompt or something
- I liked hal9001's exact estimate of how many tokens SYSTEM + AGENTS + tools had
- How about - HAL should have its own cursor - blinking orange one, and user would have blinking blue one
- File lease broadcasting via IPC — tabs announce which files they're editing so other tabs can avoid conflicts. Lightweight alternative to worktrees for concurrent multi-tab editing.
- Owner->client handoff should not pause the activity - or if that's not possible, it should resume it immediately - a bit like steering messages do
- Revisit theme system for paddings etc.
- Check that editing other projects than hal works - separate hal-dir and cwd?
- Add a tiny markdown parser for parsing llm output
- Add mouse movements on input line, selecting - multicursor maybe? - cmd-a, etc. QoL improvements
- The steering / enqueue system does not really work. Figure out how to make it to work.
- [fork] should have a break before — " --" plus empty line plus block, like [queued/steering]
- Check .hal:00-6zp handoff if had last thinking aikeet
- Error does not go to red

## Old TODO items:

- Consider doing this: richer /handoff template (Goal / Progress / Next steps / Files touched).
- Codex model is really passive — double checks everything. Add system prompt instruction to not do that.
- cmd-z should undo edits to prompt — e.g. accidental ctrl-K deleting too much.
- Do we support tool call streaming? We should, in case bash script produces slow output.
- Different tabs should be able to use different models; fork and give task to one model in one tab and another in another
- /todo command should list todos
- restore session does not replay stuff to screen immediately
- What should we do when the owner process presses ctrl-z? It should maybe record that user suspended and the clients should show it
