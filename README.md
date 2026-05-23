# Ylate

> YouTrack time tracker — currently a VS Code extension, with a desktop port in the works.

This is a monorepo managed with [pnpm workspaces](https://pnpm.io/workspaces) and [Turborepo](https://turbo.build/).

## Packages

| Package | Description |
|---|---|
| [`packages/vscode-ext`](packages/vscode-ext) | The VS Code extension (published as `JavadTavakoli.ylate`) |

Planned (see [docs/plan-desktop.md](docs/plan-desktop.md)):

- `packages/core` — pure timer state machine + YouTrack HTTP client, shared across shells
- `packages/ui` — panel HTML/CSS/JS as a static bundle, shared across shells
- `packages/desktop` — Tauri desktop app for Windows / macOS / Linux

## Development

```bash
pnpm install                          # one-time, installs everything
pnpm build                            # turbo build across all packages
pnpm watch                            # tsc --watch in every package
pnpm package                          # build .vsix (and later, desktop bundles)
pnpm --filter ylate <script>          # run a script only in the VS Code extension
```

To install the VS Code extension into your local VS Code after building:

```bash
pnpm --filter ylate package
code --install-extension packages/vscode-ext/ylate-*.vsix --force
```

Then run **Developer: Reload Window** from the command palette.

## License

[MIT](LICENSE) © 2026 Javad Tavakoli
