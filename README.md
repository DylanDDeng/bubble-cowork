<p align="center">
  <img src="build/icon.png" alt="Aegis logo" width="104" height="104" />
</p>

<h1 align="center">Aegis</h1>

<p align="center">
  <strong>A desktop workspace for coding agents, project files, and real development work.</strong>
</p>

<p align="center">
  Run Claude Code, Codex, Kimi Code, OpenCode, Grok, Pi, and Qoder without losing sight of the project around them.
</p>

<p align="center">
  <a href="https://github.com/DylanDDeng/bubble-cowork/stargazers"><img src="https://img.shields.io/github/stars/DylanDDeng/bubble-cowork?style=flat-square" alt="GitHub stars" /></a>
  <a href="https://github.com/DylanDDeng/bubble-cowork/releases/latest"><img src="https://img.shields.io/github/v/release/DylanDDeng/bubble-cowork?style=flat-square" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/macOS-primary-111827?style=flat-square&logo=apple&logoColor=white" alt="macOS primary platform" />
  <img src="https://img.shields.io/badge/Windows-experimental-2563eb?style=flat-square&logo=windows&logoColor=white" alt="Windows experimental support" />
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

Aegis turns a local project directory into a visual workspace for AI-assisted development. Conversations, tool calls, files, diffs, terminals, browser sessions, permissions, skills, and generated artifacts stay together instead of being scattered across separate apps.

> Aegis is an early personal project. It is useful today, but parts of the product may still change quickly.

## Quick Links

- [Download the latest release](https://github.com/DylanDDeng/bubble-cowork/releases/latest)
- [Core features](#core-features)
- [Supported agent runtimes](#supported-agent-runtimes)
- [Development](#development)
- [Open an issue](https://github.com/DylanDDeng/bubble-cowork/issues)

## Why Aegis

Coding agents are powerful, but the work around them is often fragmented: one window for chat, another for files, another for the terminal, and another for reviewing changes. Aegis brings those surfaces into one desktop environment:

- Organize agent sessions around actual project directories.
- Switch between supported coding-agent runtimes from one composer.
- Keep files, changes, browser output, terminals, and artifacts visible while an agent works.
- Review permission requests and execution traces in context.
- Reuse local skills, plugins, MCP servers, models, and existing CLI authentication.

## Core Features

- **Multiple coding agents** — Work with Claude Code, Codex, Kimi Code, OpenCode, Grok, Pi, and Qoder from the same interface.
- **Project-first sessions** — Create, resume, search, pin, fork, and group threads by working directory or Git worktree.
- **Live project workspace** — Browse files, preview common document formats, inspect changes, review diffs, and open generated artifacts.
- **Browser and Design Mode** — Open project pages inside Aegis, select page elements, attach visual context, and send change requests back to an agent.
- **Skills, plugins, and MCP** — Discover local capabilities and use them alongside normal prompts.
- **Permission and execution controls** — Choose provider-specific permission modes and inspect tool activity before allowing sensitive actions.
- **Developer utilities** — Use integrated terminals, pull-request views, usage dashboards, and scheduled automations without leaving the workspace.

## Supported Agent Runtimes

| Runtime | Integration |
| --- | --- |
| Claude Code | Local Claude Code runtime, skills, plugins, permissions, usage, and session controls |
| Codex | Codex app-server sessions, models, reasoning controls, skills, plugins, and reviews |
| Kimi Code | Local Kimi runtime with models, thinking controls, skills, queueing, and session resume |
| OpenCode | OpenCode sessions with model and permission controls |
| Grok | Grok Build sessions, reasoning controls, slash commands, and usage information |
| Pi | Pi agent sessions through the local runtime |
| Qoder | Qoder SDK sessions with model and permission controls |

Runtime availability depends on the corresponding CLI, account, and local configuration. Aegis reuses your existing local setup whenever possible.

## Download

Desktop builds are published on [GitHub Releases](https://github.com/DylanDDeng/bubble-cowork/releases/latest).

| Platform | Status | Builds |
| --- | --- | --- |
| macOS Apple Silicon | Primary | DMG and ZIP |
| macOS Intel | Primary | DMG and ZIP |
| Windows x64 | Experimental | Installer and portable EXE |
| Linux x64 | Experimental | AppImage |

### macOS: “Aegis is damaged and can’t be opened”

Current macOS builds are not signed and notarized. Gatekeeper may quarantine the downloaded app and show a misleading damaged-app warning.

Install Aegis in `/Applications`, then run:

```bash
xattr -cr /Applications/Aegis.app
```

You may need to repeat this after downloading an update.

### Windows support

Windows builds are produced by CI, but I do not own a Windows computer and cannot guarantee that installation or every feature works correctly on Windows. Windows bug reports, fixes, and compatibility PRs are especially welcome.

## Design Inspiration

I genuinely enjoy using Codex, especially its interface design. Aegis is my attempt to learn how an application with a similar sense of clarity and focus can be designed and built. You will therefore notice that some parts of Aegis feel familiar to Codex users.

Aegis is an independent learning project. It is not affiliated with or endorsed by OpenAI.

## Built with Vibe Coding

This project has been developed entirely through a vibe-coding workflow. It is both a working tool and an ongoing experiment in building software with coding agents.

That also means the project will have rough edges and decisions worth revisiting. If something feels wrong, incomplete, or unnecessarily complicated, please [open an issue](https://github.com/DylanDDeng/bubble-cowork/issues), submit a pull request, or fork the repository and take it in your own direction.

## Development

### Requirements

- Node.js 22
- npm
- The local coding-agent CLIs you want to use, installed and authenticated

### Run locally

```bash
git clone https://github.com/DylanDDeng/bubble-cowork.git
cd bubble-cowork
npm install
npm run dev
```

### Test and build

```bash
npm test
npm run build
```

Create local desktop packages with:

```bash
npm run dist
```

## Architecture

Aegis is an Electron application with a React renderer and a TypeScript main process. Privileged filesystem, terminal, Git, browser, and runtime operations stay in the main process and are exposed to the renderer through a preload bridge and IPC.

```text
src/
├── electron/       # Main process, IPC, persistence, and runtime adapters
├── shared/         # Shared contracts and types
└── ui/             # React application and desktop workspace

scripts/            # Verification, probes, and development tooling
build/              # Application icons and packaging resources
```

The main technologies are Electron, React, Vite, TypeScript, Tailwind CSS, Zustand, and better-sqlite3.

## Contributing

Issues and pull requests are welcome. For larger changes, opening an issue first makes it easier to agree on the problem and direction before implementation.

When contributing, please:

- Keep changes focused and explain the user-facing reason behind them.
- Add or update verification coverage for runtime and state-management changes.
- Avoid committing local credentials, generated probe reports, or account metadata.
- Use concise commit messages in the `<type>: <subject>` format.

## Acknowledgements

- [Codex](https://openai.com/codex/) for the product and interface inspiration described above.
- The teams and communities behind Claude Code, Kimi Code, OpenCode, Grok, Pi, Qoder, MCP, and the broader coding-agent ecosystem.
