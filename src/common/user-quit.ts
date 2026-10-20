// Lets the terminal tell the host that the user quit, without client code
// importing host code. On exit, the host pauses running turns if the user
// quit and no other Hal process is running.
export const userQuit = { state: { requested: false } }
