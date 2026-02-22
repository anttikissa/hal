# TODO

- Session IDs in tab names take too much space — move to a /status command or similar.
- Consider doing this: richer /handoff template (Goal / Progress / Next steps / Files touched).
- Codex model is really passive — double checks everything. Add system prompt instruction to not do that.
- cmd-z should undo edits to prompt — e.g. accidental ctrl-K deleting too much.
- Do we support tool call streaming? We should, in case bash script produces slow output.

- Windows/tabs should have their own edit buffer
- Different tabs should be able to use different models; fork and give task to one model in one tab and another in another
- /todo command should list todos

- File lease broadcasting via IPC — tabs announce which files they're editing so other tabs can avoid conflicts. Lightweight alternative to worktrees for concurrent multi-tab editing.
