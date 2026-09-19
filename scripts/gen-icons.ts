/**
 * ForumWatch 图标生产管线（npm run icons，幂等可重跑）。
 *
 * 输入  design/*.svg（源文件，SVG 硬约束见 ADR D7：librsvg 兼容——仅
 *       path/circle/rect + 至多一个 linearGradient，禁 filter/mask/style/text/pattern）
 * 输出  resources/icon.png                        512 应用图标（electron-builder 转 icns/ico）
 *       resources/icons/trayTemplate.png          16  macOS Template 托盘（简化版 SVG 直出）
 *       resources/icons/trayTemplate@2x.png       32  同上 @2x（原版 SVG 直出）
 *       resources/icons/tray.png                  16  彩色托盘（简化版 SVG 直出）
 *       resources/icons/tray@2x.png               32  同上 @2x（原版 SVG 直出）
 *       design/preview.png                        评审用 contact sheet（各档尺寸 + 深浅底 + 16px 8x 放大）
 *
 * 渲染策略：sharp 内置 librsvg。小尺寸不走位图缩放，而是按 density 换算让矢量
 * 以目标像素 1:1 直出；16px 一律用 *-simple.svg 简化版（笔画加粗、元素做减法）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DESIGN_DIR = join(ROOT, 'design')
const RESOURCES_DIR = join(ROOT, 'resources')
const TRAY_DIR = join(RESOURCES_DIR, 'icons')

interface PngJob {
  /** design/ 下的 SVG 文件名，同时作为产物 buffer 的 key */
  svg: string
  /** 输出绝对路径 */
  out: string
  /** 目标边长（px，正方形） */
  size: number
}

const PNG_JOBS: PngJob[] = [
  { svg: 'icon.svg', out: join(RESOURCES_DIR, 'icon.png'), size: 512 },
  { svg: 'tray-template-simple.svg', out: join(TRAY_DIR, 'trayTemplate.png'), size: 16 },
  { svg: 'tray-template.svg', out: join(TRAY_DIR, 'trayTemplate@2x.png'), size: 32 },
  { svg: 'tray-color-simple.svg', out: join(TRAY_DIR, 'tray.png'), size: 16 },
  { svg: 'tray-color.svg', out: join(TRAY_DIR, 'tray@2x.png'), size: 32 }
]

/** 把 design/ 下的 SVG 以目标边长矢量直出为 PNG buffer（density 换算，不做位图缩放） */
async function svgToPng(svgFile: string, size: number): Promise<Buffer> {
  const svg = await readFile(join(DESIGN_DIR, svgFile), 'utf8')
  const matched = svg.match(/viewBox="([^"]+)"/)
  if (matched === null) throw new Error(`viewBox not found in ${svgFile}`)
  const parts = matched[1].trim().split(/[\s,]+/)
  const viewBoxWidth = Number.parseFloat(parts[2])
  if (!Number.isFinite(viewBoxWidth) || viewBoxWidth <= 0) {
    throw new Error(`invalid viewBox in ${svgFile}: ${matched[1]}`)
  }
  const density = (72 * size) / viewBoxWidth
  return sharp(Buffer.from(svg), { density })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
}

// ---- 评审用 contact sheet --------------------------------------------------

interface Tile {
  input: Buffer
  left: number
  top: number
}

const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif'

function label(x: number, y: number, text: string, fill: string, size = 15, anchor = 'middle'): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${text}</text>`
}

async function buildPreview(buffers: Map<string, Buffer>): Promise<void> {
  const shrink = (buf: Buffer, size: number): Promise<Buffer> =>
    sharp(buf).resize(size, size).png().toBuffer()
  const zoom = (buf: Buffer): Promise<Buffer> =>
    sharp(buf).resize(128, 128, { kernel: 'nearest' }).png().toBuffer()
  // Template 图在深色菜单栏由系统用前景色绘制（自动反色）——preview 里如实展示反色版
  const invert = (buf: Buffer): Promise<Buffer> => sharp(buf).negate({ alpha: false }).png().toBuffer()

  const app = buffers.get('icon.svg')
  const tpl16 = buffers.get('tray-template-simple.svg')
  const tpl32 = buffers.get('tray-template.svg')
  const clr16 = buffers.get('tray-color-simple.svg')
  const clr32 = buffers.get('tray-color.svg')
  if (!app || !tpl16 || !tpl32 || !clr16 || !clr32) throw new Error('missing render buffers for preview')
  const app16 = await shrink(app, 16)

  const tiles: Tile[] = []

  // -- 行 1：应用图标 512/128/64/32/16（浅灰底，基线对齐）--
  const appRow = [
    { size: 512, x: 56 },
    { size: 128, x: 632 },
    { size: 64, x: 816 },
    { size: 32, x: 944 },
    { size: 16, x: 1056 }
  ]
  const baseY = 624
  const labels: string[] = []
  for (const item of appRow) {
    tiles.push({ input: await shrink(app, item.size), left: item.x, top: baseY - item.size })
    labels.push(label(item.x + item.size / 2, 656, `${item.size}`, '#4B5563'))
  }

  // -- 行 2-5：托盘 Template / 彩色，各浅色 + 深色两块底 --
  interface TrayRow {
    top: number
    bg: string
    title: string
    sub: string
    titleFill: string
    subFill: string
    markFill: string
    icons: [Buffer, number, number][]
  }
  const trayRows: TrayRow[] = [
    {
      top: 724, bg: '#EFEFF4', titleFill: '#374151', subFill: '#6B7280', markFill: '#9CA3AF',
      title: 'Tray template (macOS template image) - light',
      sub: 'black + alpha, follows menu bar appearance; from tray-template(-simple).svg',
      icons: [[tpl16, 940, 764], [tpl32, 1024, 756]]
    },
    {
      top: 834, bg: '#232329', titleFill: '#D1D5DB', subFill: '#9CA3AF', markFill: '#9CA3AF',
      title: 'Tray template - dark',
      sub: 'system draws template glyphs in menu-bar foreground color (shown inverted)',
      icons: [[await invert(tpl16), 940, 874], [await invert(tpl32), 1024, 866]]
    },
    {
      top: 944, bg: '#EFEFF4', titleFill: '#374151', subFill: '#6B7280', markFill: '#9CA3AF',
      title: 'Tray color (Windows) - light',
      sub: 'gradient base + white radar + cyan blip; from tray-color(-simple).svg',
      icons: [[clr16, 940, 984], [clr32, 1024, 976]]
    },
    {
      top: 1054, bg: '#232329', titleFill: '#D1D5DB', subFill: '#9CA3AF', markFill: '#9CA3AF',
      title: 'Tray color - dark',
      sub: 'same glyph on dark background',
      icons: [[clr16, 940, 1094], [clr32, 1024, 1086]]
    }
  ]
  const trayRects: string[] = []
  for (const row of trayRows) {
    trayRects.push(`<rect x="24" y="${row.top}" width="1072" height="96" rx="12" fill="${row.bg}"/>`)
    trayRects.push(
      `<text x="48" y="${row.top + 42}" font-family="${FONT}" font-size="15" font-weight="600" fill="${row.titleFill}">${row.title}</text>`,
      `<text x="48" y="${row.top + 66}" font-family="${FONT}" font-size="12" fill="${row.subFill}">${row.sub}</text>`,
      label(928, row.top + 53, '16', row.markFill, 13, 'end'),
      label(1012, row.top + 53, '32', row.markFill, 13, 'end')
    )
    for (const [buf, left, top] of row.icons) tiles.push({ input: buf, left, top })
  }

  // -- 行 6：16px 8x 最近邻放大，供人眼检查糊不糊 --
  const chipY = 1204
  const tpl16Dark = await invert(tpl16)
  interface Chip {
    x: number
    bg: string
    caption: string
    buf: Buffer
  }
  const chips: Chip[] = [
    { x: 48, bg: '#E9E9ED', caption: 'app 16', buf: app16 },
    { x: 248, bg: '#EFEFF4', caption: 'tpl 16 light', buf: tpl16 },
    { x: 448, bg: '#232329', caption: 'tpl 16 dark (inverted)', buf: tpl16Dark },
    { x: 648, bg: '#EFEFF4', caption: 'clr 16 light', buf: clr16 },
    { x: 848, bg: '#232329', caption: 'clr 16 dark', buf: clr16 }
  ]
  const chipRects: string[] = []
  for (const chip of chips) {
    chipRects.push(`<rect x="${chip.x}" y="${chipY}" width="160" height="128" rx="8" fill="${chip.bg}"/>`)
    chipRects.push(label(chip.x + 80, 1356, chip.caption, '#6B7280', 12))
    tiles.push({ input: await zoom(chip.buf), left: chip.x + 16, top: chipY })
  }

  const baseSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="1400" viewBox="0 0 1120 1400">
  <rect width="1120" height="1400" fill="#F6F6F8"/>
  <text x="48" y="56" font-family="${FONT}" font-size="24" font-weight="700" fill="#111827">ForumWatch icons - preview</text>
  <text x="48" y="84" font-family="${FONT}" font-size="14" fill="#6B7280">app icon 512/128/64/32/16 | tray template and color 16/32 on light and dark | bottom: 16px at 8x nearest zoom</text>
  <rect x="24" y="104" width="1072" height="596" rx="14" fill="#E9E9ED"/>
  ${labels.join('\n  ')}
  ${trayRects.join('\n  ')}
  <rect x="24" y="1160" width="1072" height="216" rx="14" fill="#FFFFFF" stroke="#E5E7EB"/>
  <text x="48" y="1192" font-family="${FONT}" font-size="15" font-weight="600" fill="#374151">16 px detail - 8x zoom (nearest)</text>
  ${chipRects.join('\n  ')}
</svg>`

  const basePng = await sharp(Buffer.from(baseSvg)).png().toBuffer()
  await sharp(basePng).composite(tiles).png().toFile(join(DESIGN_DIR, 'preview.png'))
}

// ---- 主流程 -----------------------------------------------------------------

async function main(): Promise<void> {
  await mkdir(TRAY_DIR, { recursive: true })
  await mkdir(DESIGN_DIR, { recursive: true })

  const buffers = new Map<string, Buffer>()
  for (const job of PNG_JOBS) {
    const buf = await svgToPng(job.svg, job.size)
    await writeFile(job.out, buf)
    buffers.set(job.svg, buf)
    console.log(`[icons] ${relative(ROOT, job.out)}  ${job.size}x${job.size}  <- design/${job.svg}`)
  }

  await buildPreview(buffers)
  console.log(`[icons] ${relative(ROOT, join(DESIGN_DIR, 'preview.png'))}  contact sheet`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
