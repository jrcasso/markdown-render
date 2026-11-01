declare module 'claude-code' {
  interface PluginState {
    'markdown-render': {
      /**
       * Whether one <details> block is expanded, keyed by
       * "<message requestId>:<segment index>". Absent means collapsed,
       * which matches the HTML element's own default.
       */
      open: StateFamily<boolean>
    }
  }
}
