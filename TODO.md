# TODO

## Do next:

- System.md analysis and revamp - what to add/remove - also better <if> for codex
- Fix Codex by better prompt or something
- I liked hal9001's exact estimate of how many tokens SYSTEM + AGENTS + tools had
- Input: make moving up and down work
- Raw mode & statusline
- How about - HAL should have its own cursor - blinking orange one, and user would have blinking blue one
- File lease broadcasting via IPC — tabs announce which files they're editing so other tabs can avoid conflicts. Lightweight alternative to worktrees for concurrent multi-tab editing.
- Styling - colors, better layout, status line, etc.
- Revisit theme system for paddings etc.
- Title bar and maybe automatic generation/update of title; should session name generate too?
- Find names of UI elements properly - title, scrollback buffer, statusline, command input, etc.
- Check that editing other projects than hal works - separate hal-dir and cwd?
- Fix cursor movements on input line
- Add a tiny markdown parser for parsing llm output
- Make the tail file thing use "tail -f" - save a few lines
- Add mouse movements on input line, selecting - multicursor maybe? - cmd-a, etc. QoL improvements

## Old TODO items:

- Session IDs in tab names take too much space — move to a /status command or similar.
- Consider doing this: richer /handoff template (Goal / Progress / Next steps / Files touched).
- Codex model is really passive — double checks everything. Add system prompt instruction to not do that.
- cmd-z should undo edits to prompt — e.g. accidental ctrl-K deleting too much.
- Do we support tool call streaming? We should, in case bash script produces slow output.

- Windows/tabs should have their own edit buffer
- Different tabs should be able to use different models; fork and give task to one model in one tab and another in another
- /todo command should list todos


