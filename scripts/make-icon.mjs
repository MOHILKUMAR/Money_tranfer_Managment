// Generates the placeholder application icon (build/icon.png and build/icon.ico)
// without external image tools: a charcoal tile with a racing-red bar chart.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const CHARCOAL = [0x2a, 0x2a, 0x2a]
const RED = [0xe1, 0x06, 0x00]
const SILVER = [0xc0, 0xc0, 0xc0]

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function render(size) {
  const px = Buffer.alloc(size * size * 4)
  const s = size / 256
  const radius = 52 * s
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius)
    const cy = Math.min(Math.max(y, radius), size - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
  }
  const bars = [
    { x: 58, w: 34, top: 140 },
    { x: 111, w: 34, top: 96 },
    { x: 164, w: 34, top: 56 }
  ]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      if (!inRounded(x + 0.5, y + 0.5)) continue
      let color = CHARCOAL
      const ux = (x + 0.5) / s
      const uy = (y + 0.5) / s
      for (const b of bars) if (ux >= b.x && ux <= b.x + b.w && uy >= b.top && uy <= 198) color = RED
      if (uy >= 206 && uy <= 214 && ux >= 48 && ux <= 208) color = SILVER
      px[i] = color[0]
      px[i + 1] = color[1]
      px[i + 2] = color[2]
      px[i + 3] = 255
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', render(512))
const sizes = [256, 128, 64, 48, 32, 16]
const images = sizes.map(render)
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = 6 + 16 * sizes.length
const entries = sizes.map((size, i) => {
  const e = Buffer.alloc(16)
  e[0] = size >= 256 ? 0 : size
  e[1] = size >= 256 ? 0 : size
  e.writeUInt16LE(1, 4)
  e.writeUInt16LE(32, 6)
  e.writeUInt32LE(images[i].length, 8)
  e.writeUInt32LE(offset, 12)
  offset += images[i].length
  return e
})
writeFileSync('build/icon.ico', Buffer.concat([header, ...entries, ...images]))
console.log('Wrote build/icon.png and build/icon.ico')
