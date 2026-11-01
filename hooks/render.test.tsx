import type { On } from 'claude-code'

import { expect, mock, test } from 'claude-code/testing'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAHgAAAAoCAYAAAA16j4lAAAAKklEQVR42u3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAODPAEsoAAEfS7LEAAAAAElFTkSuQmCC'

const message = (text: string) =>
  ({
    plugin: 'markdown-render',
    component: 'AssistantMessage',
    requestId: 'msg-1',
    surface: 'terminal',
    props: { text, isFirstOfReply: true },
  }) as const

test('a plain reply goes to the engine, task boxes drawn as glyphs', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={(e.props as { text: string }).text} />
  })

  const ui = await $.ui.mount(message('Plan:\n- [ ] write\n- [x] test\n\n```md\n- [ ] kept\n```'))
  const md = await ui.find({ type: 'Markdown' })
  expect(md?.text).toBe('Plan:\n- ☐ write\n- ☑ test\n\n```md\n- [ ] kept\n```')
  await ui.unmount()
})

test('a GitHub alert draws a titled callout', async ($, on) => {
  const ui = await $.ui.mount(message('Intro\n\n> [!WARNING]\n> Mind the **gap**\n\nAfter'))
  expect((await ui.find({ type: 'Text', text: /Warning/ }))?.text).toBe('▲ Warning')
  expect((await ui.find({ type: 'Markdown', text: /gap/ }))?.text).toBe('Mind the **gap**')
  expect((await ui.find({ type: 'Markdown', text: /After/ }))?.text).toBe('After')
  await ui.unmount()
})

const TALL_PNG = 'iVBORw0KGgoAAAANSUhEUgAABVgAABDsCAYAAAA16j4lAAAAKklEQVR42u3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAODPAEsoAAEfS7LEAAAAAElFTkSuQmCC'

const RUN_OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

for (const hasMmdr of [true, false]) {
  test(`a mermaid block shows its source, then the image (${hasMmdr ? 'mmdr' : 'mermaid-cli'})`, async ($, on) => {
    const clock = mock.clock(on)
    const runs: string[][] = []
    let rendered = false
    on('process.run', (_, e) => {
      const argv = (e as { argv: string[] }).argv
      runs.push(argv)
      if (argv[0] === '/bin/sh') return { value: { ...RUN_OK, stdout: '/Users/u' } }
      if (argv[0] !== 'find') rendered = true
      return { value: RUN_OK }
    })
    on('fs.exists', (_, e) => {
      const path = (e as { path: string }).path
      if (path.endsWith('.png')) return { value: rendered }
      if (path.endsWith('/mmdr')) return { value: hasMmdr && path === '/opt/homebrew/bin/mmdr' }
      return { value: true }
    })
    on('fs.write', () => ({ value: undefined }))
    on('fs.read', () => ({ value: { base64: PNG } }))

    const ui = await $.ui.mount(message('See:\n```mermaid\nflowchart LR\n  A --> B\n```'))
    expect((await ui.find({ type: 'Text', text: /rendering/ }))?.text).toBe('rendering diagram…')
    expect((await ui.find({ type: 'Code' }))?.text).toBe('flowchart LR\n  A --> B')

    await clock.advance(1)
    await clock.settle()

    const render = runs.find(r => r[0] !== '/bin/sh' && r[0] !== 'find')
    expect(render?.[0]).toBe(hasMmdr ? '/opt/homebrew/bin/mmdr' : '/Users/u/.cache/claude-md-render/node_modules/.bin/mmdc')
    expect(render).toContain('-c')
    expect(await ui.find({ type: 'Image' })).toBeDefined()
    await ui.unmount()
  })
}

test('a diagram taller than 4096 pixels is shrunk to fit before display', async ($, on) => {
  const clock = mock.clock(on)
  const runs: string[][] = []
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    runs.push(argv)
    return { value: argv[0] === '/bin/sh' ? { ...RUN_OK, stdout: '/Users/u' } : RUN_OK }
  })
  on('fs.exists', (_, e) => ({ value: !(e as { path: string }).path.endsWith('/mmdr') }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => ({ value: { base64: runs.some(r => r[0] === '/usr/bin/sips') ? PNG : TALL_PNG } }))

  const ui = await $.ui.mount(message('```mermaid\nflowchart TD\n  A --> B\n```'))
  await clock.advance(1)
  await clock.settle()

  const sips = runs.find(r => r[0] === '/usr/bin/sips')
  expect(sips?.slice(1, 3)).toEqual(['-Z', '4096'])
  expect(sips?.[3]).toMatch(/^\/Users\/u\/\.cache\/claude-md-render\/out\/.+\.png$/)
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.unmount()
})

test('session start prunes diagrams older than the retention setting', async ($, on) => {
  const runs: string[][] = []
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    runs.push(argv)
    return { value: argv[0] === '/bin/sh' ? { ...RUN_OK, stdout: '/Users/u' } : RUN_OK }
  })
  on('fs.exists', () => ({ value: true }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(runs.find(r => r[0] === 'find')).toEqual(['find', '/Users/u/.cache/claude-md-render/out', '-type', 'f', '-mtime', '+14', '-delete'])
})

test('an unclosed mermaid fence while streaming is not rendered yet', async ($, on) => {
  let ran = false
  on('process.run', () => {
    ran = true
    return { value: RUN_OK }
  })
  const ui = await $.ui.mount(message('```mermaid\nflowchart LR\n  A --'))
  expect((await ui.find({ type: 'Text', text: /^mermaid$/ }))?.text).toBe('mermaid')
  expect(ran).toBe(false)
  await ui.unmount()
})

const BASE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', tools: [], outputStyle: null }
const seedPrompt = (on: On) =>
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))

test('the system prompt gains diagram guidance on the terminal only', async ($, on) => {
  seedPrompt(on)

  const terminal = await $.prompt.compose({ ...BASE, surfaces: ['terminal'], traits: [] })
  expect(terminal.sections.map(s => s.id)).toEqual(['intro', 'markdown-render:formatting'])
  expect(terminal.sections[1]?.text).toContain('mermaid')
  expect(terminal.sections[1]?.scope).toBe('session')

  const printed = await $.prompt.compose({ ...BASE, surfaces: ['terminal'], traits: ['print'] })
  expect(printed.sections.map(s => s.id)).toEqual(['intro'])

  const desktop = await $.prompt.compose({ ...BASE, surfaces: ['desktop'], traits: [] })
  expect(desktop.sections.map(s => s.id)).toEqual(['intro'])
})

test('the default level is balanced', async ($, on) => {
  seedPrompt(on)
  const { sections } = await $.prompt.compose({ ...BASE, surfaces: ['terminal'], traits: [] })
  expect(sections[1]?.text).toContain('three or more things that connect')
  expect(sections[1]?.text).not.toContain('Default to including a mermaid diagram')
})

test('level off injects no section at all', { options: { diagramLevel: 'off' } }, async ($, on) => {
  seedPrompt(on)
  const { sections } = await $.prompt.compose({ ...BASE, surfaces: ['terminal'], traits: [] })
  expect(sections.map(s => s.id)).toEqual(['intro'])
})

test('level minimal holds the eagerness back', { options: { diagramLevel: 'minimal' } }, async ($, on) => {
  seedPrompt(on)
  const { sections } = await $.prompt.compose({ ...BASE, surfaces: ['terminal'], traits: [] })
  expect(sections[1]?.text).toContain('Do not reach for one by default')
  expect(sections[1]?.text).not.toContain('three or more things that connect')
})

test('level eager pushes diagrams hardest', { options: { diagramLevel: 'eager' } }, async ($, on) => {
  seedPrompt(on)
  const { sections } = await $.prompt.compose({ ...BASE, surfaces: ['terminal'], traits: [] })
  expect(sections[1]?.text).toContain('Default to including a mermaid diagram')
  expect(sections[1]?.text).toContain('draw it instead')
})

for (const level of ['minimal', 'balanced', 'eager']) {
  test(`craft and alert rules survive at level ${level}`, { options: { diagramLevel: level } }, async ($, on) => {
    seedPrompt(on)
    const { sections } = await $.prompt.compose({ ...BASE, surfaces: ['terminal'], traits: [] })
    const text = sections[1]?.text ?? ''
    expect(text).toContain('flowchart LR')
    expect(text).toContain('[!CAUTION]')
    expect(text).toContain('about 15 nodes')
  })
}

test('an unknown level falls back to balanced', { options: { diagramLevel: 'nonsense' } }, async ($, on) => {
  seedPrompt(on)
  const { sections } = await $.prompt.compose({ ...BASE, surfaces: ['terminal'], traits: [] })
  expect(sections[1]?.text).toContain('three or more things that connect')
})

test('an inline details block leaks no raw tags', async ($) => {
  const ui = await $.ui.mount(message('<details><summary>Inline</summary>body</details>'))
  const summary = await ui.find({ type: 'Text', text: /Inline/ })
  expect(summary?.text).not.toContain('<details>')
  expect(summary?.text).not.toContain('</details>')
  await ui.unmount()
})

test('a details block starts collapsed and expands when pressed', async ($) => {
  const ui = await $.ui.mount(message('<details>\n<summary>Click me</summary>\n\nhidden body\n</details>'))

  expect((await ui.find({ type: 'Text', text: /Click me/ }))?.text).toBe('▸ Click me')
  expect(await ui.find({ type: 'Markdown', text: /hidden body/ })).toBe(undefined)

  await ui.press({ key: 'details-0' })

  expect((await ui.find({ type: 'Text', text: /Click me/ }))?.text).toBe('▾ Click me')
  expect((await ui.find({ type: 'Markdown', text: /hidden body/ }))?.text).toContain('hidden body')

  await ui.press({ key: 'details-0' })
  expect(await ui.find({ type: 'Markdown', text: /hidden body/ })).toBe(undefined)

  await ui.unmount()
})

test('two details blocks in one reply toggle independently', async ($) => {
  const ui = await $.ui.mount(
    message('<details><summary>One</summary>first body</details>\n\n<details><summary>Two</summary>second body</details>'),
  )
  await ui.press({ key: 'details-1' })
  expect(await ui.find({ type: 'Markdown', text: /first body/ })).toBe(undefined)
  expect((await ui.find({ type: 'Markdown', text: /second body/ }))?.text).toContain('second body')
  await ui.unmount()
})

test('a details block with no summary still gets a label', async ($) => {
  const ui = await $.ui.mount(message('<details>\n\nbody only\n</details>'))
  expect((await ui.find({ type: 'Text', text: /Details/ }))?.text).toBe('▸ Details')
  await ui.unmount()
})

test('an unclosed details while streaming stays plain markdown', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={(e.props as { text: string }).text} />
  })
  const ui = await $.ui.mount(message('<details>\n<summary>Partial</summary>'))
  expect(await ui.find({ type: 'Button' })).toBe(undefined)
  await ui.unmount()
})

test('pressing a rendered diagram opens the PNG in the system viewer', async ($, on) => {
  const clock = mock.clock(on)
  const runs: string[][] = []
  let rendered = false
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    runs.push(argv)
    if (argv[0] === '/bin/sh') return { value: { ...RUN_OK, stdout: '/Users/u' } }
    if (argv[0] !== 'find' && argv[0] !== '/usr/bin/open') rendered = true
    return { value: RUN_OK }
  })
  on('fs.exists', (_, e) => {
    const path = (e as { path: string }).path
    if (path.endsWith('.png')) return { value: rendered }
    if (path.endsWith('/mmdr')) return { value: path === '/opt/homebrew/bin/mmdr' }
    return { value: true }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => ({ value: { base64: PNG } }))

  const ui = await $.ui.mount(message('```mermaid\nflowchart LR\n  A --> B\n```'))
  await clock.advance(1)
  await clock.settle()
  expect(await ui.find({ type: 'Image' })).toBeDefined()

  await ui.press({ key: 'diagram-0' })

  const opened = runs.find(r => r[0] === '/usr/bin/open')
  expect(opened?.[1]).toMatch(/\.png$/)
  await ui.unmount()
})

test('a thematic break is drawn as a rule, not literal dashes', async ($) => {
  const ui = await $.ui.mount(message('alpha\n\n---\n\nbeta'))
  const rule = await ui.find({ type: 'Text', text: /^─+$/ })
  expect(rule?.text).toMatch(/^─+$/)
  const texts = (await ui.findAll({ type: 'Markdown' })).map(m => (m as { text?: string }).text ?? '')
  expect(texts.join('\n')).not.toContain('---')
  await ui.unmount()
})

for (const [name, src] of [
  ['asterisks', 'alpha\n\n***\n\nbeta'],
  ['underscores', 'alpha\n\n___\n\nbeta'],
  ['long dashes', 'alpha\n\n------\n\nbeta'],
  ['spaced dashes', 'alpha\n\n- - -\n\nbeta'],
  ['html hr', 'alpha\n\n<hr>\n\nbeta'],
] as const) {
  test(`a rule written with ${name} is drawn`, async ($) => {
    const ui = await $.ui.mount(message(src))
    expect((await ui.find({ type: 'Text', text: /^─+$/ }))?.text).toMatch(/^─+$/)
    await ui.unmount()
  })
}

test('a setext heading underline is left to markdown', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={(e.props as { text: string }).text} />
  })
  const ui = await $.ui.mount(message('alpha\n---\nbeta'))
  expect(await ui.find({ type: 'Text', text: /^─+$/ })).toBe(undefined)
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('---')
  await ui.unmount()
})

test('dashes inside a code fence are not a rule', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={(e.props as { text: string }).text} />
  })
  const ui = await $.ui.mount(message('```\n---\n```'))
  expect(await ui.find({ type: 'Text', text: /^─+$/ })).toBe(undefined)
  await ui.unmount()
})

test('inline markup in a summary is not shown as raw tags', async ($) => {
  const ui = await $.ui.mount(
    message('<details><summary>What <code>[!ERROR]</code> renders as</summary>body</details>'),
  )
  const label = await ui.find({ type: 'Text', text: /ERROR/ })
  expect(label?.text).toBe('▸ What [!ERROR] renders as')
  await ui.unmount()
})

// Every theme the manifest offers must resolve to a real palette, or the
// renderer silently falls back and the setting is a lie.
for (const [theme, marker] of [
  ['nord', '#2e3440'],
  ['solarized-light', '#fdf6e3'],
  ['catppuccin-mocha', '#1e1e2e'],
  ['gruvbox-dark', '#282828'],
  ['tokyo-night', '#1a1b26'],
] as const) {
  test(`the ${theme} theme reaches the renderer`, { options: { theme } }, async ($, on) => {
    const clock = mock.clock(on)
    const writes: Record<string, string> = {}
    let rendered = false
    on('process.run', (_, e) => {
      const argv = (e as { argv: string[] }).argv
      if (argv[0] === '/bin/sh') return { value: { ...RUN_OK, stdout: '/Users/u' } }
      if (argv[0] !== 'find') rendered = true
      return { value: RUN_OK }
    })
    on('fs.exists', (_, e) => {
      const path = (e as { path: string }).path
      if (path.endsWith('.png')) return { value: rendered }
      if (path.endsWith('/mmdr')) return { value: path === '/opt/homebrew/bin/mmdr' }
      return { value: true }
    })
    on('fs.write', (_, e) => {
      const { path, text } = e as { path: string; text: string }
      writes[path] = text
      return { value: undefined }
    })
    on('fs.read', () => ({ value: { base64: PNG } }))

    const ui = await $.ui.mount(message('```mermaid\nflowchart LR\n  A --> B\n```'))
    await clock.advance(1)
    await clock.settle()

    const config = Object.entries(writes).find(([p]) => p.endsWith(`config-${theme}.json`))
    expect(config).toBeDefined()
    expect(config?.[1]).toContain(marker)
    await ui.unmount()
  })
}

test('an unknown theme falls back instead of rendering nothing', { options: { theme: 'nonsense' } }, async ($, on) => {
  const clock = mock.clock(on)
  let rendered = false
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    if (argv[0] === '/bin/sh') return { value: { ...RUN_OK, stdout: '/Users/u' } }
    if (argv[0] !== 'find') rendered = true
    return { value: RUN_OK }
  })
  on('fs.exists', (_, e) => {
    const path = (e as { path: string }).path
    if (path.endsWith('.png')) return { value: rendered }
    if (path.endsWith('/mmdr')) return { value: path === '/opt/homebrew/bin/mmdr' }
    return { value: true }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => ({ value: { base64: PNG } }))

  const ui = await $.ui.mount(message('```mermaid\nflowchart LR\n  A --> B\n```'))
  await clock.advance(1)
  await clock.settle()
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.unmount()
})
