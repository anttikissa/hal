// Shrinks an image to a long edge in a separate process, because Bun.Image
// is async and the provider request that needs the bytes is built
// synchronously. Exits nonzero if the result would change format (GIF
// becomes PNG), so the caller sends the original under its media type.
let [src, maxEdge, dest] = process.argv.slice(2) as [string, string, string]
let image = new Bun.Image(src)
let { format } = await image.metadata()
let bytes = await image.resize(Number(maxEdge), Number(maxEdge), { fit: 'inside' }).bytes()
if ((await new Bun.Image(bytes).metadata()).format !== format) process.exit(1)
await Bun.write(dest, bytes)
