import type { Register } from 'claude-code'

import { type AlertKind, type Segment, imageCells, parse, rewriteOutsideFences } from './parse'
import { type RenderSettings, diagramKey, diagrams, pruneCache, renderDiagram } from './render'

const FORMATTING_GUIDANCE = `# Diagrams and formatting
The terminal renders GitHub-flavored markdown in your replies, including \`\`\`mermaid fenced blocks drawn as images, GitHub alerts (> [!NOTE], [!TIP], [!IMPORTANT], [!WARNING], [!CAUTION]) and task lists. The user reads diagrams faster than prose and wants more of them.
- Default to including a mermaid diagram whenever a reply describes three or more things that connect, or steps that branch or loop. Typical cases: explaining how code works (call paths, data flow, module boundaries), a plan or proposal, debugging findings (where the failure enters and propagates), architecture, request or event sequences, state and lifecycle, dependencies, before-and-after changes, comparing options, timelines.
- Before writing a numbered list of steps, a "first X calls Y, which..." paragraph, or an arrow chain like A -> B -> C, draw it instead. Then let the prose add only what the diagram cannot show (why, caveats, file references); do not narrate the diagram.
- Pick the type that fits: flowchart for flow and decisions, sequenceDiagram for interactions over time, stateDiagram-v2 for lifecycles, classDiagram or erDiagram for structure and data models, gantt or timeline for schedules, mindmap for breaking down a topic.
- Prefer left-to-right layouts: start flowcharts with \`flowchart LR\` (and use \`direction LR\` in state diagrams and subgraphs), because the terminal is much wider than it is tall. Use top-down only when a single chain would run past about seven nodes in a row.
- Keep each diagram readable: about 15 nodes or fewer (split larger ones into two), short labels, no custom colors, classDef or style lines (the renderer applies its own theme). Quote any label containing punctuation, e.g. A["parse()"], and avoid parentheses, brackets or semicolons in unquoted labels so the diagram renders.
- Skip the diagram only for one-line answers, simple confirmations, single facts, or when the user asks for none.
- Use GitHub alerts to make things the user must not miss stand out from the body text. They render as colored callout boxes, so use them freely when the content fits:
  - [!NOTE] background or context worth knowing but not acting on
  - [!TIP] a shortcut, better approach or optional improvement
  - [!IMPORTANT] something the user must do or decide, or a requirement for things to work
  - [!WARNING] a risk, side effect, unverified assumption or something that could break
  - [!CAUTION] destructive or irreversible actions, data loss, security or production impact
  Typical moments: a step the user still has to run, an action that needs a restart, a result that is untested, a change that touches production or shared state, a surprising finding. Keep each alert to one to three sentences, at most about three per reply, and never wrap the whole answer in one.
- Be token-conscious with other markdown: use headings, tables and lists only where they make the reply easier to scan. No decorative formatting, no tables for two or three items.`
const ALERTS: Record<AlertKind, { title: string; icon: string; color: string }> = {
  NOTE: { title: 'Note', icon: 'ⓘ', color: '#4493f8' },
  TIP: { title: 'Tip', icon: '✦', color: '#3fb950' },
  IMPORTANT: { title: 'Important', icon: '✱', color: '#ab7df8' },
  WARNING: { title: 'Warning', icon: '▲', color: '#d29922' },
  CAUTION: { title: 'Caution', icon: '⊘', color: '#f85149' },
}

export const register: Register = (on, options) => {
  const settings: RenderSettings = {
    theme: typeof options.theme === 'string' ? options.theme : 'dracula',
    renderer: options.renderer === 'mmdr' || options.renderer === 'mermaid-cli' ? options.renderer : 'auto',
  }
  const cellAspect = typeof options.cellAspect === 'number' && options.cellAspect > 0 ? options.cellAspect : 2
  const maxRows = typeof options.maxRows === 'number' && options.maxRows > 0 ? options.maxRows : 45
  const retentionDays = typeof options.retentionDays === 'number' ? options.retentionDays : 14
  const isGuiding = options.promptGuidance !== false

  on('session.start', async ($, e, next) => {
    diagrams.clear()
    await pruneCache($, retentionDays).catch(() => undefined)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const isRendered =
      e.surfaces.includes('terminal') &&
      !e.traits.some(t => t === 'bare' || t === 'print' || t === 'teammate' || t === 'analysis')
    if (!isRendered || !isGuiding) return result
    return { sections: [...result.sections, { id: 'markdown-render:formatting', text: FORMATTING_GUIDANCE, scope: 'session' }] }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)

    const segments = parse(e.props.text)
    const isPlain = segments.every(s => s.kind === 'markdown')
    if (isPlain) {
      return next({ ...e, props: { ...e.props, text: rewriteOutsideFences(e.props.text) } })
    }

    const { Box, Text, Markdown, Code, Image } = $.ui.resolve(e)
    const maxColumns = Math.max(20, (e.viewport?.columns ?? 100) - 4)

    const drawMermaid = (source: string, isClosed: boolean) => {
      const key = diagramKey(source, settings)
      let diagram = diagrams.get(key)
      if (diagram === undefined && isClosed) {
        diagram = { status: 'pending' }
        diagrams.set(key, diagram)
        $.clock.after(0, () => void renderDiagram($, key, source, settings))
      }
      if (diagram?.status === 'ready') {
        const cells = imageCells(diagram, diagram.scale, maxColumns, cellAspect, maxRows)
        return (
          <Image source={diagram.png !== null ? { png: diagram.png } : { file: diagram.file, format: 'png' }} {...cells} alt={`mermaid diagram:\n${source}`} />
        )
      }
      return (
        <Box flexDirection="column">
          <Code source={source} language="mermaid" />
          {diagram?.status === 'failed' ? (
            <Text color="error">mermaid: {diagram.error}</Text>
          ) : (
            <Text dimColor>{isClosed ? 'rendering diagram…' : 'mermaid'}</Text>
          )}
        </Box>
      )
    }

    const drawSegment = (s: Segment) => {
      if (s.kind === 'markdown') return <Markdown text={s.text} />
      if (s.kind === 'mermaid') return drawMermaid(s.source, s.isClosed)
      const a = ALERTS[s.alert]
      return (
        <Box flexDirection="column" paddingLeft={2}>
          <Box position="absolute" top={0} bottom={0} left={0} width={1} overflow="hidden">
            <Text color={a.color}>{'▎\n'.repeat(200)}</Text>
          </Box>
          <Text color={a.color} bold>
            {a.icon} {a.title}
          </Text>
          {s.body.trim() !== '' && <Markdown text={s.body} />}
        </Box>
      )
    }

    const body = segments.map((s, i) => (
      <Box key={`s${i}`} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
        {drawSegment(s)}
      </Box>
    ))

    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text>{e.props.isFirstOfReply ? '⏺' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {body}
        </Box>
      </Box>
    )
  })
}
