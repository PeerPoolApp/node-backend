/**
 * Recolor the PeerPool launcher logo to red for the admin APK.
 * Keeps shading by remapping hue only (blues/greens → reds).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(__dirname, '../../vue-frontend/src/assets/icon/logo.png')
const destDir = path.resolve(__dirname, '../../admin-frontend/assets')
const destSrc = path.resolve(__dirname, '../../admin-frontend/src/assets/icon')

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h * 360, s, l]
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hn = h / 360
  return [
    Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, hn) * 255),
    Math.round(hue2rgb(p, q, hn - 1 / 3) * 255),
  ]
}

/** Map brand blues/greens onto a red family while keeping contrast. */
function mapHue(h: number): number {
  if (h >= 70 && h < 180) {
    // greens → coral / light red
    const t = (h - 70) / 110
    return 18 - t * 18
  }
  if (h >= 180 && h <= 280) {
    // blues → deep red
    const t = (h - 180) / 100
    return (355 + t * 20) % 360
  }
  return h
}

const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const out = Buffer.from(data)
for (let i = 0; i < out.length; i += 4) {
  const a = out[i + 3]!
  if (a < 12) continue
  const r = out[i]!
  const g = out[i + 1]!
  const b = out[i + 2]!
  if (r > 245 && g > 245 && b > 245) continue
  const [h, s, l] = rgbToHsl(r, g, b)
  const [nr, ng, nb] = hslToRgb(mapHue(h), Math.min(1, s * 1.05), l)
  out[i] = nr
  out[i + 1] = ng
  out[i + 2] = nb
}

const png = await sharp(out, {
  raw: { width: info.width, height: info.height, channels: 4 },
}).png().toBuffer()

mkdirSync(destDir, { recursive: true })
mkdirSync(destSrc, { recursive: true })
writeFileSync(path.join(destDir, 'logo.png'), png)
writeFileSync(path.join(destSrc, 'logo.png'), png)
console.log('Wrote red admin logo', png.length, 'bytes')
