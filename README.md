# Sessix Server

The Mac-side backend for **[Sessix](https://apps.apple.com/app/sessix/id6744076728)** — an AI coding command center for vibe coders.

Let AI work on your Mac. Monitor, approve, and direct [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions from your phone.

## What is this?

Sessix Server runs on your Mac and bridges Claude Code sessions to the Sessix mobile app over your local network. It provides:

- **Session management** — Start, monitor, and control Claude Code sessions remotely
- **Tool approval** — Approve or reject tool calls (file writes, shell commands, etc.) from your phone
- **Real-time streaming** — Live output from Claude Code via WebSocket
- **mDNS discovery** — Auto-discover the server from the Sessix app on the same network
- **Push notifications** — Get notified when Claude needs your approval (via APNs)
- **Live Activity** — See session status on your iPhone's Dynamic Island

## Quick Start

```bash
npx sessix-server
```

That's it. A QR code will appear in your terminal — scan it with the Sessix app to connect.

### Requirements

- **Node.js 22+**
- **Claude Code** installed (`npm install -g @anthropic-ai/claude-code`)
- **Sessix app** on your iPhone ([App Store](https://apps.apple.com/app/sessix/id6744076728))

## How It Works

```
iPhone (Sessix App)
    ↕ WebSocket (LAN)
Mac (Sessix Server)
    ↕ stream-json stdin/stdout
Claude Code (CLI process)
```

1. Sessix Server spawns Claude Code as a child process using `--input-format stream-json --output-format stream-json`
2. Messages from the app are forwarded to Claude Code's stdin as NDJSON
3. Claude Code's stdout events are streamed back to the app via WebSocket
4. Tool approval requests go through Claude Code's PreToolUse hook mechanism → HTTP to the server → WebSocket to the app → user decision → back to Claude Code

## Architecture

```
packages/
├── shared/              # Shared TypeScript types (events, sessions, etc.)
└── mac-server/          # The server
    └── src/
        ├── index.ts             # CLI entry point
        ├── server.ts            # Server orchestration (exportable for embedding)
        ├── providers/
        │   ├── ExecutionProvider.ts   # Abstract interface
        │   └── ProcessProvider.ts     # child_process implementation
        ├── session/
        │   ├── SessionManager.ts      # Session lifecycle + event dispatch
        │   ├── SessionFileWatcher.ts  # Watch external sessions (VS Code, etc.)
        │   └── ProjectReader.ts       # Read ~/.claude/projects/
        ├── ws/
        │   └── WsBridge.ts           # WebSocket server (port 3745)
        ├── approval/
        │   └── ApprovalProxy.ts      # HTTP approval proxy (port 3746)
        ├── hooks/
        │   └── HookInstaller.ts      # Claude Code hook installer
        ├── notification/
        │   ├── NotificationService.ts
        │   ├── MacNotificationChannel.ts
        │   └── ExpoNotificationChannel.ts
        ├── mdns/
        │   └── MdnsService.ts        # LAN service discovery
        └── pairing/
            └── PairingManager.ts     # QR code pairing flow
```

## Building from Source

```bash
git clone https://github.com/ampere1988/Sessix-Server.git
cd Sessix-Server
npm install
npm run build
node packages/mac-server/dist/index.js
```

## Development

```bash
npm run dev    # Builds shared types, then starts mac-server in watch mode
```

## Ports

| Port | Protocol  | Purpose          |
|------|-----------|------------------|
| 3745 | WebSocket | App ↔ Server     |
| 3746 | HTTP      | Approval proxy   |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSIX_AUTO_CONNECT` | `true` | Enable mDNS auto-discovery (`false` to disable) |

## Embedding

Sessix Server can be embedded in other Node.js applications (e.g., an Electron app):

```typescript
import { start, stop } from 'sessix-server'

const server = await start({ enableAutoConnect: true })
// ... later
await server.stop()
```

## Related

- **Sessix App** — [App Store](https://apps.apple.com/app/sessix/id6744076728)
- **sessix-server on npm** — [npmjs.com/package/sessix-server](https://www.npmjs.com/package/sessix-server)

## License

MIT
