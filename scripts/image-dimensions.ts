// On-demand image header reader, run by file-page only when opening an
// image page. Nothing under src imports it at host startup.
import { imageDimensions } from '../src/common/image-dimensions.ts'

let type = process.argv[2] ?? ''
let size = imageDimensions.read(Buffer.from(await Bun.stdin.arrayBuffer()), type)
console.log(size ? `${size.width} × ${size.height}` : '')
