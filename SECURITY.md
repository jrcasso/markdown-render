# Security

## Reporting a vulnerability

Please report security issues through GitHub's private vulnerability reporting
on this repository (Security tab, "Report a vulnerability") rather than opening
a public issue.

## What this plugin can do on your machine

markdown-render is a Claude Code hooks module. It is worth knowing what it
touches before you install it, and the list is short:

- **Runs a diagram renderer.** It executes `mmdr` or `mermaid-cli` on mermaid
  source taken from Claude's replies, and `sips` to shrink oversized output.
  Diagram source is written to, and PNGs are read from, `~/.cache/claude-md-render`.
- **Opens a file in your image viewer** when you press the `⤢ open` control
  under a diagram, via `/usr/bin/open` on the cached PNG for that diagram.
- **Deletes its own cached diagrams** older than `retentionDays` at session start.
- **Adds a section to the system prompt** describing how to use diagrams and
  alerts, unless `diagramLevel` is `off`.

It makes no network requests of its own, reads no files outside its own cache,
and holds no credentials. The renderers it invokes are third-party software you
install yourself; mermaid-cli drives a headless Chrome.

## Supply chain

- The GitHub Actions workflow pins `actions/checkout` to a commit SHA, not a
  movable tag, and runs with a read-only `GITHUB_TOKEN`.
- `main` is protected: no force pushes, no deletions, and CI must pass.
- Dependabot watches the pinned action for updates.
