// Shrinks an image to fit a square of the given side and writes it to
// stdout. A separate process, because Bun.Image is async and provider
// requests are built synchronously. Bun.Image writes a GIF as PNG.
let [path, side] = process.argv.slice(2) as [string, string]
await Bun.write(Bun.stdout, await new Bun.Image(path).resize(+side, +side, { fit: 'inside' }).bytes())
