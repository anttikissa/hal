import type { Reply } from './synthetic.ts'

const squares = ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3']
const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]]
const order = [4, 0, 2, 6, 8, 1, 3, 5, 7]

function result(board: string[]): string | undefined {
	for (let [a, b, c] of lines) if (board[a!] !== '.' && board[a!] === board[b!] && board[a!] === board[c!]) return board[a!]
	if (!board.includes('.')) return 'draw'
}

function move(board: string[], square: string): string[] {
	let at = squares.indexOf(square)
	if (at < 0 || board[at] !== '.' || introGame.result(board)) throw new Error(`Invalid tic-tac-toe move ${square} on ${board.join('')}`)
	let next = [...board]
	next[at] = 'X'
	if (introGame.result(next)) return next
	let empty = order.filter((i) => next[i] === '.')
	let wins = (mark: string) => empty.find((i) => {
		let trial = [...next]
		trial[i] = mark
		return introGame.result(trial) === mark
	})
	next[wins('O') ?? wins('X') ?? empty[0]!] = 'O'
	return next
}

function reply(board: string[]): Reply {
	let rows = [0, 3, 6].map((i) => `${i / 3 + 1}  ${board.slice(i, i + 3).map((s) => s === '.' ? ' ' : s).join(' | ')}`)
	let say = `You are X; I am O. Escape leaves the game.\n\n\`\`\`\n   A   B   C\n${rows.join('\n  ---+---+---\n')}\n\`\`\``
	let outcome = introGame.result(board)
	if (outcome) return { say: `${say}\n\n${outcome === 'X' ? 'You win.' : outcome === 'O' ? 'I win.' : 'A draw. The only winning move was apparently all nine of them.'} Say "tic-tac-toe" to play again.` }
	return { say, ask: { text: 'Your move?', skip: true, fields: [{ type: 'choice', name: `intro_move_${board.join('')}`, options: squares.filter((_, i) => board[i] === '.') }] } }
}

export const introGame = { result, move, reply }
