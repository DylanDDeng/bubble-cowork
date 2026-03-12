<p align="center">
  <img src="build/icon.png" alt="Aegis logo" width="96" height="96" />
</p>

<h1 align="center">Aegis</h1>

<p align="center">
  A desktop AI workspace for running real project work with Claude, Codex, MCP tools, and local files.
</p>

<p align="center">
  English | <a href="./README.zh-CN.md">简体中文</a>
</p>

## What Aegis Does

Aegis turns a local project folder into an AI operating surface. Instead of treating chats, generated files, and tool activity as separate steps, it keeps them in one desktop workflow:

- Start and organize multiple AI work sessions around real project directories
- Switch between Claude Code and Codex from the same interface
- Connect Anthropic-compatible providers such as MiniMax, Zhipu, Moonshot, and DeepSeek
- Use MCP servers and Claude skills alongside normal prompts
- Browse project files, preview outputs, and inspect generated artifacts without leaving the app
- Keep project context visible through session grouping, file panels, and usage surfaces

## Core Capabilities

### Multi-session AI workspace
- Create separate sessions for different tasks and projects
- Resume, search, pin, and group work by project folder
- Track tool traces, thinking output, and intermediate results in context

### Local project-first workflow
- Bind every session to a working directory
- Browse files from the right-side project panel
- Open, reveal, and preview common output formats including HTML, Markdown, PDF, images, and PPTX

### Claude and provider routing
- Use Claude Code directly
- Route Claude-style requests through compatible providers
- Configure model selection, access mode, and runtime health from Settings

### Skills, MCP, and extensibility
- Discover local Claude skills from user and project scopes
- Browse and install marketplace skills from within the app
- Configure MCP servers globally or per project

### Desktop polish
- Theme families, appearance modes, and typography controls
- In-app update checks that open GitHub Releases for manual download
- Context usage indicator in the composer for Claude sessions

## Typical Use Cases

- Explore a repository with AI while keeping files and outputs visible
- Generate deliverables such as PPTX, PDF, or DOCX from project context
- Run repeatable prompt workflows with Claude skills and MCP servers
- Compare model/provider behavior without leaving the same desktop environment

## Tech Stack

- Electron
- React
- Vite
- TypeScript
- Tailwind CSS
- better-sqlite3

## Getting Started

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run dist
```

## Project Structure

```text
.
├── src/            # Electron main process and React UI
├── dist-react/     # Built frontend output
├── dist-electron/  # Built Electron output
├── release/        # Packaged app artifacts
└── build/          # App icons and build resources
```

## Notes

- Aegis currently supports manual update installation through GitHub Releases
- macOS artifacts are produced from the current release setup; Windows packaging depends on a compatible build environment
