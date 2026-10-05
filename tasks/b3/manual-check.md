# b3 manual TTY check (2026-09-26)

Real pty via `expect` (no kitty protocol, so Escape arrived as a lone
ESC and went through the idle timer).

- Real home with the user's copied credentials: the prompt was
  accepted and the turn ended with the error line "anthropic token
  refresh failed: HTTP 400 invalid_grant; log in again if this
  persists". The copied OAuth token is expired and its refresh token
  is dead, so no real model answer is possible until the user copies
  fresh credentials. No secret was printed.
- Temp home, local.ts pointing anthropic at a local fake server and
  stubbing auth.anthropic: answer streamed, Escape canceled a held
  turn ("[canceled]"), Ctrl-R restarted into the same conversation,
  Ctrl-C quit leaving the last frame on screen.

Limitations:
- One session per process: ./run opens the newest session on disk (or
  creates one). No picker, no tabs, no /commands.
- Without a TTY, ./run prints "hal needs a terminal" and exits 1.
- A lone ESC waits terminal.escapeMs() (50 ms) for the rest of a
  sequence; a sequence split by a slower link would read as Escape.
- Every frame holds the whole history (tasks/cc); long conversations
  repaint canonically once they outgrow the screen.
- Refused commands and host loss show as a dim notice above the
  prompt; it clears on the next submit or reconnect.
- Enter while a turn runs keeps the typed text instead of queueing it.
