// Tells the host that the user quit Hal.
//
// The host must know this when the process exits. If the user quit and no
// other Hal process is running, the host pauses running turns, so nothing
// keeps working without the user. The terminal sees the quit, but client
// code cannot import host code. So the terminal sets this flag, and the
// host reads it.
export const userQuit = { state: { requested: false } }
