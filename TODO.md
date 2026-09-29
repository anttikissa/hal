# Later

Wanted, but not before a second release. When one is picked up, make it
a task and remove it here.

- `/keys` on the web lists only keys the web has, and the web gets
  Ctrl-M (questions.md item 56).
- `/config`: the settings table as a form (item 60, task pc).
- A light/dark theme setting (item 61, task 1w).
- Linux and Windows browsers: Ctrl-P and Ctrl-T/W/N go to the browser,
  so only Alt-digits switch web tabs there, and there is no button to
  reopen a closed tab (item 52). Wait for the first user to complain.
- Linux browsers could get Alt-T/W/N/P for tabs (item 106); the user
  only has a Mac.
- Side-channel chatter between agents in one directory: tool results
  carry short notes like "157-abc is editing turns.ts" (item 116).
- A context graph: cmd-click the status row's context number to open a
  web page plotting context size per block; each drop is a compaction
  or pruning, later also cache misses (item 135).
- `hal -r <host>`: the terminal client connects to a remote hal2 host
  (e.g. example.com) over the web socket, logging in with a one-time
  code and remembering host and token; `hal -r` alone reuses the last
  one. Old Hal: src/main.ts (remoteHost), src/client/remote-auth.ts,
  src/client/web-connection.ts. Progress reports list it under REACH.
