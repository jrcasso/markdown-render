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

test('the system prompt gains diagram guidance on the terminal only', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  const base = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', tools: [], outputStyle: null }

  const terminal = await $.prompt.compose({ ...base, surfaces: ['terminal'], traits: [] })
  expect(terminal.sections.map(s => s.id)).toEqual(['intro', 'markdown-render:formatting'])
  expect(terminal.sections[1]?.text).toContain('mermaid')
  expect(terminal.sections[1]?.scope).toBe('session')

  const printed = await $.prompt.compose({ ...base, surfaces: ['terminal'], traits: ['print'] })
  expect(printed.sections.map(s => s.id)).toEqual(['intro'])

  const desktop = await $.prompt.compose({ ...base, surfaces: ['desktop'], traits: [] })
  expect(desktop.sections.map(s => s.id)).toEqual(['intro'])
})
