import type { EngineInterface } from 'claude-code'

import { fnv1a, pngSize } from './parse'

export type Diagram =
  | { status: 'pending' }
  | { status: 'ready'; png: string | null; file: string; width: number; height: number; scale: number }
  | { status: 'failed'; error: string }

export type Renderer = 'mmdr' | 'mermaid-cli'

export type RenderSettings = {
  theme: string
  renderer: 'auto' | Renderer
}

type Palette = { theme: string; border: string; variables?: Record<string, string> }

const PALETTES: Record<string, Palette> = {
  dracula: {
    theme: 'base',
    border: '#bd93f9',
    variables: {
      darkMode: 'true',
      background: '#282a36',
      fontFamily: 'ui-sans-serif, -apple-system, Helvetica, Arial, sans-serif',
      primaryColor: '#44475a',
      primaryTextColor: '#f8f8f2',
      primaryBorderColor: '#bd93f9',
      secondaryColor: '#6272a4',
      secondaryTextColor: '#f8f8f2',
      secondaryBorderColor: '#ff79c6',
      tertiaryColor: '#21222c',
      tertiaryTextColor: '#f8f8f2',
      tertiaryBorderColor: '#8be9fd',
      lineColor: '#8be9fd',
      textColor: '#f8f8f2',
      mainBkg: '#44475a',
      nodeBorder: '#bd93f9',
      clusterBkg: '#21222c',
      clusterBorder: '#6272a4',
      edgeLabelBackground: '#282a36',
      titleColor: '#f8f8f2',
      noteBkgColor: '#6272a4',
      noteTextColor: '#f8f8f2',
      noteBorderColor: '#ff79c6',
      actorBkg: '#44475a',
      actorBorder: '#bd93f9',
      actorTextColor: '#f8f8f2',
      actorLineColor: '#6272a4',
      signalColor: '#8be9fd',
      signalTextColor: '#f8f8f2',
      labelBoxBkgColor: '#44475a',
      labelBoxBorderColor: '#bd93f9',
      labelTextColor: '#f8f8f2',
      loopTextColor: '#f8f8f2',
      activationBkgColor: '#6272a4',
      activationBorderColor: '#bd93f9',
      sequenceNumberColor: '#282a36',
      pie1: '#bd93f9', pie2: '#ff79c6', pie3: '#8be9fd', pie4: '#50fa7b',
      pie5: '#ffb86c', pie6: '#f1fa8c', pie7: '#ff5555', pie8: '#6272a4',
      git0: '#bd93f9', git1: '#ff79c6', git2: '#8be9fd', git3: '#50fa7b',
      git4: '#ffb86c', git5: '#f1fa8c', git6: '#ff5555', git7: '#6272a4',
      critBkgColor: '#ff5555',
      doneTaskBkgColor: '#50fa7b',
      activeTaskBkgColor: '#8be9fd',
      taskBkgColor: '#bd93f9',
      taskTextColor: '#282a36',
      sectionBkgColor: '#44475a',
      altSectionBkgColor: '#282a36',
      gridColor: '#6272a4',
      todayLineColor: '#ff79c6',
    },
  },
  dark: { theme: 'dark', border: '#cccccc' },
  default: { theme: 'default', border: '#9370db' },
  neutral: { theme: 'neutral', border: '#999999' },
  forest: { theme: 'forest', border: '#13540c' },
}

const MMDC_SCALE = 3
const MMDR_SCALE = 1
const MAX_INLINE_BYTES = 2 * 1024 * 1024
const MAX_SIDE = 4096
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const MMDR_CANDIDATES = ['/opt/homebrew/bin/mmdr', '/usr/local/bin/mmdr']

export const diagrams = new Map<string, Diagram>()
let toolDir: Promise<string> | null = null

export function resolveToolDir($: EngineInterface): Promise<string> {
  toolDir ??= $.process
    .run(['/bin/sh', '-c', 'printf %s "$HOME"'])
    .then(r => `${r.stdout}/.cache/claude-md-render`)
  return toolDir
}

export const paletteOf = (theme: string): Palette => PALETTES[theme] ?? PALETTES.dark!

export const diagramKey = (source: string, settings: RenderSettings): string =>
  fnv1a(`v5\n${settings.renderer}\n${settings.theme}\n${source}`)

const mermaidConfig = (p: Palette) =>
  JSON.stringify({ theme: p.theme, ...(p.variables ? { themeVariables: p.variables } : {}) })

const crispCss = (p: Palette) =>
  [
    '* { filter: none !important; box-shadow: none !important; }',
    `.node rect, .node circle, .node ellipse, .node polygon, .node path, .cluster rect { stroke: ${p.border} !important; stroke-width: 1px !important; }`,
  ].join('\n')

async function findMmdr($: EngineInterface, dir: string): Promise<string | null> {
  const home = dir.replace(/\/\.cache\/claude-md-render$/, '')
  for (const path of [...MMDR_CANDIDATES, `${home}/.cargo/bin/mmdr`]) {
    if (await $.fs.exists(path)) return path
  }
  return null
}

async function pickRenderer($: EngineInterface, dir: string, wanted: RenderSettings['renderer']) {
  const mmdr = wanted === 'mermaid-cli' ? null : await findMmdr($, dir)
  if (mmdr) return { kind: 'mmdr' as const, bin: mmdr }
  if (wanted === 'mmdr') throw new Error('mmdr not found: brew tap 1jehuang/mmdr && brew install mmdr')
  const mmdc = `${dir}/node_modules/.bin/mmdc`
  if (await $.fs.exists(mmdc)) return { kind: 'mermaid-cli' as const, bin: mmdc }
  throw new Error('no renderer: brew tap 1jehuang/mmdr && brew install mmdr')
}

const firstError = (out: string, code: number) =>
  (out.split('\n').find(l => /error/i.test(l)) ?? out).trim().slice(0, 300) || `renderer exited ${code}`

async function readPng($: EngineInterface, path: string) {
  const { base64 } = await $.fs.read(path, { as: 'bytes' })
  return { base64, size: pngSize(Uint8Array.from(atob(base64.slice(0, 64)), c => c.charCodeAt(0))) }
}

export async function renderDiagram($: EngineInterface, key: string, source: string, settings: RenderSettings) {
  try {
    const dir = await resolveToolDir($)
    const palette = paletteOf(settings.theme)
    const input = `${dir}/out/${key}.mmd`
    const output = `${dir}/out/${key}.png`
    const renderer = await pickRenderer($, dir, settings.renderer)
    const baseScale = renderer.kind === 'mmdr' ? MMDR_SCALE : MMDC_SCALE

    if (!(await $.fs.exists(output))) {
      await $.fs.write(input, source)
      const config = `${dir}/config-${settings.theme}.json`
      await $.fs.write(config, mermaidConfig(palette))
      let argv: string[]
      if (renderer.kind === 'mmdr') {
        argv = [renderer.bin, '-i', input, '-o', output, '-e', 'png', '-c', config]
      } else {
        const puppeteer = `${dir}/puppeteer.json`
        if (!(await $.fs.exists(puppeteer))) {
          await $.fs.write(puppeteer, JSON.stringify({ executablePath: CHROME, headless: 'shell' }))
        }
        const css = `${dir}/crisp-${settings.theme}.css`
        await $.fs.write(css, crispCss(palette))
        argv = [renderer.bin, '-p', puppeteer, '-c', config, '-C', css, '-i', input, '-o', output,
          '-b', 'transparent', '-s', String(baseScale), '-q']
      }
      const r = await $.process.run(argv, { timeoutMs: 60_000 })
      if (r.exitCode !== 0) throw new Error(`${renderer.kind}: ${firstError(r.stderr || r.stdout, r.exitCode)}`)
    }

    let { base64, size } = await readPng($, output)
    if (!size) throw new Error(`${renderer.kind} produced no PNG`)
    let scale = baseScale
    if (Math.max(size.width, size.height) > MAX_SIDE) {
      const r = await $.process.run(['/usr/bin/sips', '-Z', String(MAX_SIDE), output], { timeoutMs: 30_000 })
      if (r.exitCode !== 0) throw new Error(`diagram too large to shrink: ${size.width}x${size.height}`)
      const before = size.width
      ;({ base64, size } = await readPng($, output))
      if (!size || Math.max(size.width, size.height) > MAX_SIDE) throw new Error('diagram too large to display')
      scale = baseScale * (size.width / before)
    }
    const isInline = base64.length * 0.75 <= MAX_INLINE_BYTES
    diagrams.set(key, { status: 'ready', png: isInline ? base64 : null, file: output, scale, ...size })
  } catch (err) {
    diagrams.set(key, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
  }
  $.ui.invalidate('ui.render')
}

export async function pruneCache($: EngineInterface, retentionDays: number) {
  const dir = await resolveToolDir($)
  if (!(await $.fs.exists(`${dir}/out`))) return
  await $.process.run(['find', `${dir}/out`, '-type', 'f', '-mtime', `+${Math.max(1, Math.floor(retentionDays))}`, '-delete'])
}
