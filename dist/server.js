"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_net_1 = __importDefault(require("node:net"));
const node_path_1 = __importDefault(require("node:path"));
const node_process_1 = __importDefault(require("node:process"));
const history_1 = require("./history");
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 5050;
const HISTORY_FILE = node_path_1.default.resolve(node_process_1.default.cwd(), "chat-history.jsonl");
const MAX_PHOTO_BYTES = 3 * 1024 * 1024; // 3MB cap per photo
class ChatServer {
    constructor(host, port) {
        this.clients = new Map();
        this.groups = new Map();
        this.contexts = new Map();
        this.shuttingDown = false;
        this.host = host;
        this.port = port;
        this.server = node_net_1.default.createServer((socket) => this.handleConnection(socket));
        this.history = new history_1.HistoryStore(HISTORY_FILE, 1000);
    }
    start() {
        this.server.listen(this.port, this.host, () => {
            console.log(`Server listening on ${this.host}:${this.port}`);
        });
        const shutdown = () => {
            if (this.shuttingDown) {
                return;
            }
            this.shuttingDown = true;
            console.log("\nShutting down server...");
            this.server.close(() => {
                console.log("Server stopped.");
            });
            for (const context of this.contexts.values()) {
                context.socket.end("Server shutting down.\n");
            }
            this.history.close();
        };
        this.server.on("error", (err) => {
            console.error("Server error:", err.message);
        });
        this.server.on("close", () => {
            this.history.close();
        });
        node_process_1.default.once("SIGINT", shutdown);
        node_process_1.default.once("SIGTERM", shutdown);
    }
    handleConnection(socket) {
        socket.setEncoding("utf8");
        const context = {
            socket,
            buffer: "",
            address: socket.remoteAddress ?? "unknown",
            port: socket.remotePort ?? 0,
        };
        this.contexts.set(socket, context);
        this.sendLine(socket, "Welcome to the network lab chat server!");
        this.promptNickname(context);
        socket.on("data", (chunk) => this.handleSocketData(context, chunk));
        socket.on("close", () => this.cleanupClient(context));
        socket.on("error", () => this.cleanupClient(context));
    }
    promptNickname(context) {
        this.sendLine(context.socket, "Enter a nickname (letters, numbers, underscores). Use /quit to abort.");
    }
    handleSocketData(context, chunk) {
        if (context.closed) {
            return;
        }
        const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        context.buffer += data;
        while (true) {
            const newlineIndex = context.buffer.indexOf("\n");
            if (newlineIndex === -1) {
                break;
            }
            let line = context.buffer.slice(0, newlineIndex);
            context.buffer = context.buffer.slice(newlineIndex + 1);
            line = line.replace(/\r$/, "").trim();
            if (!line) {
                continue;
            }
            if (!context.name) {
                const shouldClose = this.handleNicknameNegotiation(context, line);
                if (shouldClose) {
                    return;
                }
            }
            else if (line.startsWith("/")) {
                const shouldClose = this.processCommand(context, line);
                if (shouldClose) {
                    return;
                }
            }
            else {
                this.sendLine(context.socket, "Unknown input. Use /help to see the list of supported commands.");
            }
        }
    }
    handleNicknameNegotiation(context, candidate) {
        if (candidate.toLowerCase() === "/quit") {
            this.sendLine(context.socket, "Goodbye!");
            context.socket.end();
            return true;
        }
        if (!/^[A-Za-z0-9_]+$/.test(candidate)) {
            this.sendLine(context.socket, "Nickname must be alphanumeric (underscores allowed). Try again:");
            return false;
        }
        if (this.clients.has(candidate)) {
            this.sendLine(context.socket, "Name already in use. Try another:");
            return false;
        }
        context.name = candidate;
        this.clients.set(candidate, context);
        this.sendLine(context.socket, `Hello ${candidate}! Type /help to see commands.`);
        this.sendHelp(context.socket);
        this.broadcastSystem(`${candidate} joined the chat.`);
        return false;
    }
    processCommand(context, raw) {
        if (!context.name) {
            return false;
        }
        const tokens = raw.trim().split(/\s+/);
        const cmd = tokens[0].toLowerCase();
        switch (cmd) {
            case "/help":
                this.sendHelp(context.socket);
                break;
            case "/list":
                if (tokens.length < 2) {
                    this.sendLine(context.socket, "Usage: /list users|groups");
                }
                else if (tokens[1].toLowerCase() === "users") {
                    this.listUsers(context.socket);
                }
                else if (tokens[1].toLowerCase() === "groups") {
                    this.listGroups(context.socket);
                }
                else {
                    this.sendLine(context.socket, "Unknown list target. Use users or groups.");
                }
                break;
            case "/msg":
                if (tokens.length < 3) {
                    this.sendLine(context.socket, "Usage: /msg <nickname> <message>");
                }
                else {
                    const target = tokens[1];
                    const message = tokens.slice(2).join(" ");
                    this.sendPrivate(context.name, target, message, context.socket);
                }
                break;
            case "/group":
                this.handleGroupCommand(context, tokens, raw);
                break;
            case "/history":
                this.handleHistoryCommand(context, tokens);
                break;
            case "/photo":
                this.handlePhotoCommand(context, tokens);
                break;
            case "/quit":
                this.sendLine(context.socket, "Disconnecting. Bye!");
                context.socket.end();
                return true;
            default:
                this.sendLine(context.socket, "Unknown command. Use /help to see all options.");
        }
        return false;
    }
    handleGroupCommand(context, tokens, raw) {
        if (!context.name) {
            return;
        }
        if (tokens.length < 3) {
            this.sendLine(context.socket, "Usage: /group create|join|leave|send <group_name> [message]");
            return;
        }
        const action = tokens[1].toLowerCase();
        const groupName = tokens[2];
        switch (action) {
            case "create":
                this.groupCreate(context.name, groupName, context.socket);
                break;
            case "join":
                this.groupJoin(context.name, groupName, context.socket);
                break;
            case "leave":
                this.groupLeave(context.name, groupName, context.socket);
                break;
            case "send": {
                if (tokens.length < 4) {
                    this.sendLine(context.socket, "Usage: /group send <group_name> <message>");
                    return;
                }
                const message = tokens.slice(3).join(" ");
                this.groupSend(context.name, groupName, message, context.socket);
                break;
            }
            default:
                this.sendLine(context.socket, "Unknown group action (create|join|leave|send).");
        }
    }
    sendHelp(socket) {
        const helpLines = [
            "Commands:",
            "  /help                             Show this help message",
            "  /list users                       Show all connected clients",
            "  /list groups                      Show all groups with members",
            "  /msg <user> <message>             Send a private message",
            "  /group create <name>              Create a new group (you join automatically)",
            "  /group join <name>                Join an existing group",
            "  /group leave <name>               Leave a group you're part of",
            "  /group send <name> <message>      Send a message to a group you're in",
            "  /history [count]                  View recent chat history (default 20, max 100)",
            "  /photo <@user|#group> <mime> <name> <base64> [caption]  Send an image (<= 3MB)",
            "  /quit                             Disconnect from the server",
        ];
        this.sendLine(socket, helpLines.join("\n"));
    }
    listUsers(socket) {
        const names = [...this.clients.keys()].sort();
        if (names.length === 0) {
            this.sendLine(socket, "No connected users.");
            return;
        }
        this.sendLine(socket, `Online users (${names.length}): ${names.join(", ")}`);
    }
    listGroups(socket) {
        if (this.groups.size === 0) {
            this.sendLine(socket, "No groups have been created.");
            return;
        }
        const lines = [...this.groups.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([group, members]) => {
            const memberList = [...members].sort().join(", ") || "(empty)";
            return `${group}: ${memberList}`;
        });
        this.sendLine(socket, lines.join("\n"));
    }
    sendPrivate(sender, target, message, origin) {
        const recipient = this.clients.get(target);
        if (!recipient) {
            this.sendLine(origin, `${target} is not online.`);
            return;
        }
        this.sendLine(recipient.socket, `[PM] ${sender}: ${message}`);
        this.sendLine(origin, `[PM -> ${target}] ${message}`);
        this.history.append({
            type: "private",
            timestamp: Date.now(),
            sender,
            target,
            message,
            audience: [sender, target],
        });
    }
    groupCreate(sender, groupName, origin) {
        if (this.groups.has(groupName)) {
            this.sendLine(origin, "Group already exists.");
            return;
        }
        this.groups.set(groupName, new Set([sender]));
        this.sendLine(origin, `Created group ${groupName} and joined it.`);
    }
    groupJoin(sender, groupName, origin) {
        const members = this.groups.get(groupName);
        if (!members) {
            this.sendLine(origin, "Group does not exist.");
            return;
        }
        members.add(sender);
        this.sendLine(origin, `Joined group ${groupName}.`);
    }
    groupLeave(sender, groupName, origin) {
        const members = this.groups.get(groupName);
        if (!members || !members.has(sender)) {
            this.sendLine(origin, "You are not a member of that group.");
            return;
        }
        members.delete(sender);
        if (members.size === 0) {
            this.groups.delete(groupName);
        }
        this.sendLine(origin, `Left group ${groupName}.`);
    }
    groupSend(sender, groupName, message, origin) {
        const members = this.groups.get(groupName);
        if (!members || !members.has(sender)) {
            this.sendLine(origin, "You must join the group before sending messages.");
            return;
        }
        const audience = [...members];
        for (const member of members) {
            if (member === sender) {
                continue;
            }
            const recipient = this.clients.get(member);
            if (recipient) {
                this.sendLine(recipient.socket, `[Group:${groupName}] ${sender}: ${message}`);
            }
        }
        this.sendLine(origin, `[Group:${groupName}] (you): ${message}`);
        this.history.append({
            type: "group",
            timestamp: Date.now(),
            sender,
            group: groupName,
            message,
            audience,
        });
    }
    handlePhotoCommand(context, tokens) {
        if (!context.name) {
            return;
        }
        if (tokens.length < 5) {
            this.sendLine(context.socket, "Usage: /photo <@user|#group> <mime> <name> <base64_data> [caption]");
            return;
        }
        const rawTarget = tokens[1];
        if (!rawTarget.startsWith("@") && !rawTarget.startsWith("#")) {
            this.sendLine(context.socket, "Target must start with @ (user) or # (group).");
            return;
        }
        const mime = tokens[2];
        const name = tokens[3];
        const base64Data = tokens[4];
        const caption = tokens.slice(5).join(" ").trim();
        if (!mime.startsWith("image/")) {
            this.sendLine(context.socket, "Only image mime types are supported (image/*).");
            return;
        }
        if (!/^[A-Za-z0-9._-]+$/.test(name)) {
            this.sendLine(context.socket, "Image name must only use letters, numbers, dot, dash, underscore.");
            return;
        }
        let buffer;
        try {
            buffer = Buffer.from(base64Data, "base64");
        }
        catch {
            this.sendLine(context.socket, "Invalid base64 payload.");
            return;
        }
        if (buffer.length === 0) {
            this.sendLine(context.socket, "Photo payload was empty.");
            return;
        }
        if (buffer.length > MAX_PHOTO_BYTES) {
            this.sendLine(context.socket, `Photo exceeds ${MAX_PHOTO_BYTES} bytes (3MB limit).`);
            return;
        }
        const normalizedTarget = rawTarget.slice(1);
        if (!normalizedTarget) {
            this.sendLine(context.socket, "Provide a user or group name after @ / #.");
            return;
        }
        if (rawTarget.startsWith("@")) {
            this.sendPrivatePhoto(context.name, normalizedTarget, mime, name, base64Data, buffer.length, caption);
        }
        else {
            this.groupSendPhoto(context.name, normalizedTarget, mime, name, base64Data, buffer.length, caption);
        }
    }
    sendPrivatePhoto(sender, target, mime, name, data, size, caption) {
        const recipient = this.clients.get(target);
        const origin = this.clients.get(sender);
        if (!recipient) {
            origin?.socket && this.sendLine(origin.socket, `${target} is not online.`);
            return;
        }
        const payload = this.buildPhotoPayload("private", sender, {
            target,
            mime,
            name,
            data,
            caption,
            size,
        });
        this.dispatchPhotoPayload(recipient.socket, payload);
        if (origin) {
            this.dispatchPhotoPayload(origin.socket, payload);
        }
        this.history.append({
            type: "private",
            timestamp: payload.timestamp,
            sender,
            target,
            message: caption || "[photo]",
            audience: [sender, target],
            media: {
                kind: "photo",
                mime,
                name,
                data,
                size,
            },
        });
    }
    groupSendPhoto(sender, groupName, mime, name, data, size, caption) {
        const members = this.groups.get(groupName);
        const origin = this.clients.get(sender);
        if (!members || !members.has(sender)) {
            origin?.socket &&
                this.sendLine(origin.socket, "You must join the group before sending messages.");
            return;
        }
        const payload = this.buildPhotoPayload("group", sender, {
            group: groupName,
            mime,
            name,
            data,
            caption,
            size,
        });
        for (const member of members) {
            const context = this.clients.get(member);
            if (context) {
                this.dispatchPhotoPayload(context.socket, payload);
            }
        }
        this.history.append({
            type: "group",
            timestamp: payload.timestamp,
            sender,
            group: groupName,
            message: caption || "[photo]",
            audience: [...members],
            media: {
                kind: "photo",
                mime,
                name,
                data,
                size,
            },
        });
    }
    buildPhotoPayload(kind, sender, options) {
        return {
            kind,
            sender,
            timestamp: Date.now(),
            ...options,
        };
    }
    dispatchPhotoPayload(socket, payload) {
        this.sendLine(socket, `PHOTO ${JSON.stringify(payload)}`);
    }
    broadcastSystem(message) {
        for (const context of this.clients.values()) {
            this.sendLine(context.socket, `[System] ${message}`);
        }
        this.history.append({
            type: "system",
            timestamp: Date.now(),
            message,
        });
    }
    cleanupClient(context) {
        if (context.closed) {
            return;
        }
        context.closed = true;
        this.contexts.delete(context.socket);
        if (context.name) {
            this.clients.delete(context.name);
            for (const [groupName, members] of this.groups) {
                if (members.delete(context.name) && members.size === 0) {
                    this.groups.delete(groupName);
                }
            }
            this.broadcastSystem(`${context.name} left the chat.`);
        }
    }
    handleHistoryCommand(context, tokens) {
        if (!context.name) {
            return;
        }
        let limit = 20;
        if (tokens.length >= 2) {
            const requested = Number(tokens[1]);
            if (Number.isNaN(requested) || requested <= 0) {
                this.sendLine(context.socket, "Usage: /history [positive count]");
                return;
            }
            limit = Math.min(100, Math.floor(requested));
        }
        const entries = this.history.getRecent(limit, (entry) => this.historyEntryVisible(entry, context.name));
        if (entries.length === 0) {
            this.sendLine(context.socket, "No history available yet.");
            return;
        }
        const lines = entries.map((entry) => this.formatHistoryEntry(entry, context.name));
        this.sendLine(context.socket, lines.join("\n"));
    }
    historyEntryVisible(entry, requester) {
        if (entry.type === "system") {
            return true;
        }
        if (entry.audience) {
            return entry.audience.includes(requester);
        }
        if (entry.type === "private") {
            return entry.sender === requester || entry.target === requester;
        }
        if (entry.type === "group" && entry.group) {
            return this.isGroupMember(requester, entry.group);
        }
        return false;
    }
    formatHistoryEntry(entry, requester) {
        if (entry.media?.kind === "photo") {
            const payload = {
                kind: entry.group ? "group" : "private",
                sender: entry.sender ?? "unknown",
                target: entry.target,
                group: entry.group,
                mime: entry.media.mime,
                name: entry.media.name ?? "photo",
                data: entry.media.data,
                caption: entry.message && entry.message !== "[photo]" ? entry.message : undefined,
                size: entry.media.size,
                timestamp: entry.timestamp,
            };
            return `PHOTO ${JSON.stringify(payload)}`;
        }
        const timestamp = this.formatTimestamp(entry.timestamp);
        switch (entry.type) {
            case "private": {
                const direction = entry.sender === requester ? `-> ${entry.target}` : `<- ${entry.sender}`;
                return `[${timestamp}] [PM ${direction}] ${entry.message}`;
            }
            case "group":
                return `[${timestamp}] [Group:${entry.group}] ${entry.sender ?? "unknown"}: ${entry.message}`;
            case "system":
            default:
                return `[${timestamp}] [System] ${entry.message}`;
        }
    }
    formatTimestamp(value) {
        const iso = new Date(value).toISOString();
        return iso.replace("T", " ").slice(0, 19);
    }
    isGroupMember(name, groupName) {
        const members = this.groups.get(groupName);
        return !!members && members.has(name);
    }
    sendLine(socket, message) {
        if (socket.writable) {
            socket.write(`${message}\n`);
        }
    }
}
function parseArgs(argv) {
    let host = DEFAULT_HOST;
    let port = DEFAULT_PORT;
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--host" && i + 1 < argv.length) {
            host = argv[++i];
        }
        else if ((arg === "--port" || arg === "-p") && i + 1 < argv.length) {
            const value = Number(argv[++i]);
            if (!Number.isNaN(value) && value > 0 && value < 65536) {
                port = value;
            }
            else {
                console.warn("Invalid port specified; using default.");
            }
        }
        else if ((arg === "-h" || arg === "--help")) {
            printUsage();
            node_process_1.default.exit(0);
        }
        else if (arg === "--host") {
            console.warn("Missing value for --host; using default.");
        }
    }
    return { host, port };
}
function printUsage() {
    console.log("Usage: ts-node src/server.ts [--host <host>] [--port <port>]");
}
function main() {
    const args = parseArgs(node_process_1.default.argv);
    const server = new ChatServer(args.host, args.port);
    server.start();
}
if (require.main === module) {
    main();
}
