// Reads an image's dimensions from its header in a separate process, so
// this code stays off the host's startup path. file-page runs it only when
// it opens an image page; nothing under src imports it at host startup.
import { imageDimensions } from '../src/common/image-dimensions.ts'

let type = process.argv[2] ?? ''
let size = imageDimensions.read(Buffer.from(await Bun.stdin.arrayBuffer()), type)
console.log(size ? `${size.width} × ${size.height}` : '')
