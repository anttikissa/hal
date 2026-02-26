# TODO

## Do next:

UI work:

Title needs to be visible (some kind of background, grey maybe)

Title needs to have maybe the session name (since we will remove from tab bar)

Model name must be super visible somewhere (as Opus 4.5, not blabla/claude-opus-4.5)

Add names to different parts - what is the place where user writes? What are the statuslines above that?
So I can call them by names

Tabs need to be like so:

 [1 .hal] 2 lines  3 lippu.1  4 lippu.2

So only the directory is shown, and if there are two in same dir, then .1 etc. disambiguates.
Active tab must be very white - and inactives can be grey but still readable (good contrast)
Let's try to drop the ------ line from background

The line "Model: Idle" line needs more info - maybe the Opus 4.5 / Codex 5.2 can show there?

Prompt that is written to screen after I press enter must be grey on every line, not just
line-before and line-after

I want to see tab activity in the tab view. Maybe put an a character between the number and
directory when there's activity?



- When I restart the app, I need to see past messages. Whether the app is client, or owner. This sometimes happens but sometimes it's buggy

- Architect commands vs keybindings so they can't diverge: every keybinding should call the same function as its corresponding slash command. Audit all pairs (ctrl-w / /close, ctrl-t / /new, etc.) and make the architecture obvious enough that dumb models won't re-introduce duplicate code paths.
- System.md analysis and revamp - what to add/remove - also better <if> for codex
- Fix Codex by better prompt or something
- I liked hal9001's exact estimate of how many tokens SYSTEM + AGENTS + tools had
- Input: make moving up and down work
- Raw mode & statusline
- How about - HAL should have its own cursor - blinking orange one, and user would have blinking blue one
- File lease broadcasting via IPC — tabs announce which files they're editing so other tabs can avoid conflicts. Lightweight alternative to worktrees for concurrent multi-tab editing.
- Owner->client handoff should not pause the activity - or if that's not possible, it should resume it immediately - a bit like steering messages do
- Styling - colors, better layout, status line, etc.
- Revisit theme system for paddings etc.
- Title bar and maybe automatic generation/update of title; should session name generate too?
- Find names of UI elements properly - title, scrollback buffer, statusline, command input, etc.
- Check that editing other projects than hal works - separate hal-dir and cwd?
- Fix cursor movements on input line
- Add a tiny markdown parser for parsing llm output
- Make the tail file thing use "tail -f" - save a few lines
- Add mouse movements on input line, selecting - multicursor maybe? - cmd-a, etc. QoL improvements
- The steering / enqueue system does not really work. Figure out how to make it to work.

## Old TODO items:

- Session IDs in tab names take too much space — move to a /status command or similar.
- Consider doing this: richer /handoff template (Goal / Progress / Next steps / Files touched).
- Codex model is really passive — double checks everything. Add system prompt instruction to not do that.
- cmd-z should undo edits to prompt — e.g. accidental ctrl-K deleting too much.
- Do we support tool call streaming? We should, in case bash script produces slow output.

- Windows/tabs should have their own edit buffer
- Different tabs should be able to use different models; fork and give task to one model in one tab and another in another
- /todo command should list todos


- restore session does not replay stuff to screen immediately
- What should we do when the owner process presses ctrl-z? It should maybe record that user suspended and the clients should show it
- What should we do when the owner process presses ctrl-z? It should maybe record that user suspended and the clients should show it
