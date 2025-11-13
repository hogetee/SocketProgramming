## Simple Socket Chat Project

This repository bootstraps the term project requirements for a socket-based chat system using a full TypeScript/Node.js stack (server + CLI client) that communicates over plain TCP sockets.

### Features implemented now
- Event-driven multi-client server built with Node's `net` module while sharing synchronized in-memory state.
- Unique nickname enforcement before a client can interact with others.
- `/list users`, `/list groups`, `/msg <user> ...`, `/group create|join|leave|send`, `/quit`, and `/help` commands.
- Private direct messaging plus opt-in group messaging that only delivers to members of the group.

### Running the TypeScript server
1. Install dependencies (Node.js 18+ recommended):
   ```bash
   npm install
   ```
2. Start the server (defaults to `0.0.0.0:5050`):
   ```bash
   npm run dev              # ts-node for quick runs
   # or
   npm start                # compiles to dist/ then runs with node
   ```
### Running the TypeScript client
1. With the server already running, start the client CLI:
   ```bash
   npm run client:dev          # ts-node interactive client
   # or
   npm run client:start        # uses the compiled dist/client.js
   ```
2. Optionally pre-fill a nickname:
   ```bash
   npm run client:dev -- --name alice
   ```
3. Supply `--host` / `--port` if you need to connect to a remote machine.

### Using the client
- Enter a nickname when prompted. It must be unique across all active clients.
- The terminal now keeps a **separate chat room** (window + input box) for every private peer (`@alice`) or group (`#lab`). Type `/chat @nickname` or `/chat #group` to focus a room and then type plain text to send within that room.
- Use `/rooms` to list open rooms + unread counts, and `/system` to jump back to server/system output. Messages for inactive rooms stay in their own windows until you switch.
- Standard server commands still work anywhere: `/help`, `/list users`, `/list groups`, `/msg <user> ...`, `/group create|join|leave|send ...`, `/quit`, etc. The client automatically redraws the active room whenever new messages arrive there.
- Examples:
  - Start a private chat: `/chat @alice`, then type `Hello there!`
  - List who is online: `/list users`
  - Create a group named `lab`: `/group create lab`, open it via `/chat #lab`, then type to talk to the group
  - Leave a group: `/group leave lab`

### Next steps / ideas
- Persist chat history to disk or a database instead of keeping it in-memory.
- Replace the terminal client with a GUI or web UI (for example, build a WebSocket bridge and React/Next.js front-end) for the "chat box" requirement.
- Add authentication, TLS, and command throttling for production-like deployments.
- Containerize the server for easier deployment/testing.
