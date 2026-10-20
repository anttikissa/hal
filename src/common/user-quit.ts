// Whether the user quit this process (Ctrl-C, /quit, SIGTERM or SIGHUP in
// the terminal). The client sets it; the host's exit handler reads it to
// decide whether running turns are recorded paused (tasks/j1/states.md).
export const userQuit = { state: { requested: false } }
