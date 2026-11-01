import type { Register } from 'claude-code'

import { atom, read, update } from 'claude-code'

import { type AlertKind, type Segment, imageCells, parse, rewriteOutsideFences } from './parse'
import { type RenderSettings, diagramKey, diagrams, pruneCache, renderDiagram } from './render'

const DIAGRAM_LEVELS = ['off', 'minimal', 'balanced', 'eager'] as const
type DiagramLevel = (typeof DIAGRAM_LEVELS)[number]

const GUIDANCE_INTRO = `# Diagrams and formatting
The terminal renders GitHub-flavored markdown in your replies: \`\`\`mermaid fenced blocks are drawn as images, GitHub alerts become coloured callout boxes, and task lists, footnotes, <details>, <kbd> and <br> all render.`

const EAGERNESS: Record<Exclude<DiagramLevel, 'off'>, string> = {
  minimal: `Diagrams are available but are not the default. Draw one only where it genuinely beats prose: when the user asks for a diagram, when the shape of the thing is itself the answer (an architecture, a state machine, a schema), or when a relationship has too many edges to follow in a sentence. Do not reach for one by default. Anything you can say clearly in two sentences, a list of independent items, or a plain explanation stays prose.`,
  balanced: `Include a mermaid diagram when a reply describes three or more things that connect, or steps that branch or loop. Typical cases: how code works (call paths, data flow, module boundaries), a plan or proposal, debugging findings (where a failure enters and how it propagates), architecture, request or event sequences, state and lifecycle, dependencies, before-and-after changes, comparing options, and timelines. One diagram suits most replies; reach for a second only when a reply genuinely covers two separate structures. Skip the diagram for one-line answers, simple confirmations, single facts, a list of unrelated items, or when the user asks for none.`,
  eager: `Default to including a mermaid diagram. The user reads diagrams faster than prose and wants more of them. Before writing a numbered list of steps, a "first X calls Y, which..." paragraph, or an arrow chain like A -> B -> C, draw it instead. Lead with the diagram and let the prose follow it. Any reply covering three or more connected things, or steps that branch or loop, gets one: how code works, a plan or proposal, debugging findings, architecture, request or event sequences, state and lifecycle, dependencies, before-and-after changes, comparing options, timelines. Two diagrams are right when a reply covers two distinct structures. Only a one-line answer, a simple confirmation, a single fact, or an explicit request for none is exempt.`,
}

const GUIDANCE_CRAFT = `Choosing the type: flowchart for flow, branching and decisions; sequenceDiagram for interactions between parties over time; stateDiagram-v2 for lifecycles and state machines; classDiagram or erDiagram for structure and data models; gantt or timeline for schedules; mindmap for breaking a topic into parts.

Keeping a diagram renderable and readable:
- Start flowcharts with \`flowchart LR\`, and use \`direction LR\` in state diagrams and subgraphs, because the terminal is far wider than it is tall. Use top-down only when a single chain would run past about seven nodes in a row.
- Keep each diagram to about 15 nodes or fewer, with short labels; split a larger one into two diagrams.
- Quote any label containing punctuation, for example A["parse()"], and avoid parentheses, brackets and semicolons in unquoted labels, which fail to parse.
- Do not write classDef, style lines or custom colors: the renderer applies its own theme over them.
- Let the prose add only what the diagram cannot show (why, caveats, file references). Never narrate the diagram in text.

Using GitHub alerts, which render as coloured callout boxes:
- [!NOTE] background or context worth knowing but not acting on
- [!TIP] a shortcut, better approach or optional improvement
- [!IMPORTANT] something the user must do or decide, or a requirement for things to work
- [!WARNING] a risk, side effect, unverified assumption or something that could break
- [!CAUTION] destructive or irreversible actions, data loss, security or production impact
Typical moments: a step the user still has to run, an action that needs a restart, a result that is untested, a change that touches production or shared state, a surprising finding. Keep each alert to one to three sentences, at most about three per reply, and never wrap a whole answer in one.

Be token-conscious with other markdown: use headings, tables and lists only where they make the reply easier to scan. No decorative formatting, and no tables for two or three items.`

const OPEN = { plugin: 'markdown-render', key: 'open' } as const
const OPEN_COMMAND = '/usr/bin/open'

const isDiagramLevel = (v: unknown): v is DiagramLevel =>
  typeof v === 'string' && (DIAGRAM_LEVELS as readonly string[]).includes(v)

const guidanceFor = (level: DiagramLevel): string | null =>
  level === 'off' ? null : `${GUIDANCE_INTRO}

${EAGERNESS[level]}

${GUIDANCE_CRAFT}`
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
  const level: DiagramLevel = isDiagramLevel(options.diagramLevel) ? options.diagramLevel : 'balanced'
  const guidance = guidanceFor(level)

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
    if (!isRendered || guidance === null) return result
    return { sections: [...result.sections, { id: 'markdown-render:formatting', text: guidance, scope: 'session' }] }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)

    const segments = parse(e.props.text)
    const isPlain = segments.every(s => s.kind === 'markdown')
    if (isPlain) {
      return next({ ...e, props: { ...e.props, text: rewriteOutsideFences(e.props.text) } })
    }

    const { Box, Text, Markdown, Code, Image, Button } = $.ui.resolve(e)
    const maxColumns = Math.max(20, (e.viewport?.columns ?? 100) - 4)

    const openStates = new Map<number, boolean>()
    await Promise.all(
      segments.map(async (s, i) => {
        if (s.kind !== 'details') return
        openStates.set(i, (await read($, atom({ ...OPEN, id: `${e.requestId}:${i}` }, false))) === true)
      }),
    )

    const drawDetails = (s: Extract<Segment, { kind: 'details' }>, index: number) => {
      const isOpen = openStates.get(index) === true
      return (
        <Box flexDirection="column">
          <Button
            key={`details-${index}`}
            label={s.summary}
            onPress={() => void update($, atom({ ...OPEN, id: `${e.requestId}:${index}` }, false), v => v !== true)}
          >
            <Text bold>
              {isOpen ? '▾' : '▸'} {s.summary}
            </Text>
          </Button>
          {isOpen && s.body.trim() !== '' && (
            <Box paddingLeft={2}>
              <Markdown text={s.body} />
            </Box>
          )}
        </Box>
      )
    }

    const drawMermaid = (source: string, isClosed: boolean, index: number) => {
      const key = diagramKey(source, settings)
      let diagram = diagrams.get(key)
      if (diagram === undefined && isClosed) {
        diagram = { status: 'pending' }
        diagrams.set(key, diagram)
        $.clock.after(0, () => void renderDiagram($, key, source, settings))
      }
      if (diagram?.status === 'ready') {
        const cells = imageCells(diagram, diagram.scale, maxColumns, cellAspect, maxRows)
        const file = diagram.file
        return (
          <Box flexDirection="column">
            <Image source={diagram.png !== null ? { png: diagram.png } : { file, format: 'png' }} {...cells} alt={`mermaid diagram:\n${source}`} />
            <Button key={`diagram-${index}`} label="open diagram" onPress={() => void $.process.run([OPEN_COMMAND, file])}>
              <Text dimColor>⤢ open</Text>
            </Button>
          </Box>
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

    const drawSegment = (s: Segment, index: number) => {
      if (s.kind === 'markdown') return <Markdown text={s.text} />
      if (s.kind === 'mermaid') return drawMermaid(s.source, s.isClosed, index)
      if (s.kind === 'details') return drawDetails(s, index)
      if (s.kind === 'rule') {
        return (
          <Text dimColor>
            {'─'.repeat(Math.max(4, maxColumns))}
          </Text>
        )
      }
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
        {drawSegment(s, i)}
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
