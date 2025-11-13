import net, { Socket } from "node:net";
import path from "node:path";
import process from "node:process";
import { HistoryEntry, HistoryStore } from "./history";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 5050;
const HISTORY_FILE = path.resolve(process.cwd(), "chat-history.jsonl");
const MAX_PHOTO_BYTES = 3 * 1024 * 1024; // 3MB cap per photo

interface PhotoPayload {
    kind: "private" | "group";
    sender: string;
    target?: string;
    group?: string;
    mime: string;
    data: string;
    name?: string;
    caption?: string;
    size: number;
    timestamp: number;
    id: number;
    deleted?: boolean;
}

interface DeletePayload {
    id: number;
    type: "private" | "group";
    sender: string;
    target?: string;
    group?: string;
    by: string;
}

interface ClientContext {
    socket: Socket;
    buffer: string;
    address: string;
    port: number;
    name?: string;
    closed?: boolean;
}

type GroupMap = Map<string, Set<string>>;

class ChatServer {
    private readonly host: string;
    private readonly port: number;
    private readonly server: net.Server;
    private readonly clients: Map<string, ClientContext> = new Map();
    private readonly groups: GroupMap = new Map();
    private readonly contexts: Map<Socket, ClientContext> = new Map();
    private readonly history: HistoryStore;
    private shuttingDown = false;

    constructor(host: string, port: number) {
        this.host = host;
        this.port = port;
        this.server = net.createServer((socket) => this.handleConnection(socket));
        this.history = new HistoryStore(HISTORY_FILE, 1000);
    }

    public start(): void {
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

        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
    }

    private handleConnection(socket: Socket): void {
        socket.setEncoding("utf8");
        const context: ClientContext = {
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

    private promptNickname(context: ClientContext): void {
        this.sendLine(
            context.socket,
            "Enter a nickname (letters, numbers, underscores). Use /quit to abort."
        );
    }

    private handleSocketData(context: ClientContext, chunk: string | Buffer): void {
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
            } else if (line.startsWith("/")) {
                const shouldClose = this.processCommand(context, line);
                if (shouldClose) {
                    return;
                }
            } else {
                this.sendLine(
                    context.socket,
                    "Unknown input. Use /help to see the list of supported commands."
                );
            }
        }
    }

    private handleNicknameNegotiation(context: ClientContext, candidate: string): boolean {
        if (candidate.toLowerCase() === "/quit") {
            this.sendLine(context.socket, "Goodbye!");
            context.socket.end();
            return true;
        }
        if (!/^[A-Za-z0-9_]+$/.test(candidate)) {
            this.sendLine(
                context.socket,
                "Nickname must be alphanumeric (underscores allowed). Try again:"
            );
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

    private processCommand(context: ClientContext, raw: string): boolean {
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
                } else if (tokens[1].toLowerCase() === "users") {
                    this.listUsers(context.socket);
                } else if (tokens[1].toLowerCase() === "groups") {
                    this.listGroups(context.socket);
                } else {
                    this.sendLine(context.socket, "Unknown list target. Use users or groups.");
                }
                break;
            case "/msg":
                if (tokens.length < 3) {
                    this.sendLine(context.socket, "Usage: /msg <nickname> <message>");
                } else {
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
            case "/delete":
                this.handleDeleteCommand(context, tokens);
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

    private handleGroupCommand(context: ClientContext, tokens: string[], raw: string): void {
        if (!context.name) {
            return;
        }
        if (tokens.length < 3) {
            this.sendLine(
                context.socket,
                "Usage: /group create|join|leave|send <group_name> [message]"
            );
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

    private sendHelp(socket: Socket): void {
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
            "  /delete <message_id>              Delete one of your recent messages",
            "  /quit                             Disconnect from the server",
        ];
        this.sendLine(socket, helpLines.join("\n"));
    }

    private listUsers(socket: Socket): void {
        const names = [...this.clients.keys()].sort();
        if (names.length === 0) {
            this.sendLine(socket, "No connected users.");
            return;
        }
        this.sendLine(socket, `Online users (${names.length}): ${names.join(", ")}`);
    }

    private listGroups(socket: Socket): void {
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

    private sendPrivate(sender: string, target: string, message: string, origin: Socket): void {
        const recipient = this.clients.get(target);
        if (!recipient) {
            this.sendLine(origin, `${target} is not online.`);
            return;
        }
        const entry = this.history.add({
            type: "private",
            timestamp: Date.now(),
            sender,
            target,
            message,
            audience: [sender, target],
        });
        this.sendLine(recipient.socket, this.renderPrivateIncoming(entry));
        this.sendLine(origin, this.renderPrivateOutgoing(entry));
    }

    private groupCreate(sender: string, groupName: string, origin: Socket): void {
        if (this.groups.has(groupName)) {
            this.sendLine(origin, "Group already exists.");
            return;
        }
        this.groups.set(groupName, new Set([sender]));
        this.sendLine(origin, `Created group ${groupName} and joined it.`);
    }

    private groupJoin(sender: string, groupName: string, origin: Socket): void {
        const members = this.groups.get(groupName);
        if (!members) {
            this.sendLine(origin, "Group does not exist.");
            return;
        }
        members.add(sender);
        this.sendLine(origin, `Joined group ${groupName}.`);
    }

    private groupLeave(sender: string, groupName: string, origin: Socket): void {
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

    private groupSend(sender: string, groupName: string, message: string, origin: Socket): void {
        const members = this.groups.get(groupName);
        if (!members || !members.has(sender)) {
            this.sendLine(origin, "You must join the group before sending messages.");
            return;
        }
        const audience = [...members];
        const entry = this.history.add({
            type: "group",
            timestamp: Date.now(),
            sender,
            group: groupName,
            message,
            audience,
        });
        for (const member of members) {
            if (member === sender) {
                this.sendLine(origin, this.renderGroupLine(entry, true));
                continue;
            }
            const recipient = this.clients.get(member);
            if (recipient) {
                this.sendLine(recipient.socket, this.renderGroupLine(entry, false));
            }
        }
    }

    private handlePhotoCommand(context: ClientContext, tokens: string[]): void {
        if (!context.name) {
            return;
        }
        if (tokens.length < 5) {
            this.sendLine(
                context.socket,
                "Usage: /photo <@user|#group> <mime> <name> <base64_data> [caption]"
            );
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
        let buffer: Buffer;
        try {
            buffer = Buffer.from(base64Data, "base64");
        } catch {
            this.sendLine(context.socket, "Invalid base64 payload.");
            return;
        }
        if (buffer.length === 0) {
            this.sendLine(context.socket, "Photo payload was empty.");
            return;
        }
        if (buffer.length > MAX_PHOTO_BYTES) {
            this.sendLine(
                context.socket,
                `Photo exceeds ${MAX_PHOTO_BYTES} bytes (3MB limit).`
            );
            return;
        }
        const normalizedTarget = rawTarget.slice(1);
        if (!normalizedTarget) {
            this.sendLine(context.socket, "Provide a user or group name after @ / #.");
            return;
        }
        if (rawTarget.startsWith("@")) {
            this.sendPrivatePhoto(
                context.name,
                normalizedTarget,
                mime,
                name,
                base64Data,
                buffer.length,
                caption
            );
        } else {
            this.groupSendPhoto(
                context.name,
                normalizedTarget,
                mime,
                name,
                base64Data,
                buffer.length,
                caption
            );
        }
    }

    private sendPrivatePhoto(
        sender: string,
        target: string,
        mime: string,
        name: string,
        data: string,
        size: number,
        caption: string
    ): void {
        const recipient = this.clients.get(target);
        const origin = this.clients.get(sender);
        if (!recipient) {
            origin?.socket && this.sendLine(origin.socket, `${target} is not online.`);
            return;
        }
        const entry = this.history.add({
            type: "private",
            timestamp: Date.now(),
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
        const payload = this.buildPhotoPayload(entry, {
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
    }

    private groupSendPhoto(
        sender: string,
        groupName: string,
        mime: string,
        name: string,
        data: string,
        size: number,
        caption: string
    ): void {
        const members = this.groups.get(groupName);
        const origin = this.clients.get(sender);
        if (!members || !members.has(sender)) {
            origin?.socket &&
                this.sendLine(origin.socket, "You must join the group before sending messages.");
            return;
        }
        const audience = [...members];
        const entry = this.history.add({
            type: "group",
            timestamp: Date.now(),
            sender,
            group: groupName,
            message: caption || "[photo]",
            audience,
            media: {
                kind: "photo",
                mime,
                name,
                data,
                size,
            },
        });
        const payload = this.buildPhotoPayload(entry, {
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
    }

    private buildPhotoPayload(
        entry: HistoryEntry,
        options: {
            target?: string;
            group?: string;
            mime: string;
            name: string;
            data: string;
            caption?: string;
            size: number;
        }
    ): PhotoPayload {
        return {
            kind: entry.type === "group" ? "group" : "private",
            sender: entry.sender ?? "unknown",
            target: options.target ?? entry.target,
            group: options.group ?? entry.group,
            timestamp: entry.timestamp,
            id: entry.id,
            deleted: entry.deleted,
            ...options,
        };
    }

    private dispatchPhotoPayload(socket: Socket, payload: PhotoPayload): void {
        this.sendLine(socket, `PHOTO ${JSON.stringify(payload)}`);
    }

    private broadcastSystem(message: string): void {
        this.history.add({
            type: "system",
            timestamp: Date.now(),
            message,
        });
        for (const context of this.clients.values()) {
            this.sendLine(context.socket, `[System] ${message}`);
        }
    }

    private cleanupClient(context: ClientContext): void {
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

    private handleHistoryCommand(context: ClientContext, tokens: string[]): void {
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
        const entries = this.history.getRecent(limit, (entry) =>
            this.historyEntryVisible(entry, context.name!)
        );
        if (entries.length === 0) {
            this.sendLine(context.socket, "No history available yet.");
            return;
        }
        const lines = entries.map((entry) => this.formatHistoryEntry(entry, context.name!));
        this.sendLine(context.socket, lines.join("\n"));
    }

    private handleDeleteCommand(context: ClientContext, tokens: string[]): void {
        if (!context.name) {
            return;
        }
        if (tokens.length < 2) {
            this.sendLine(context.socket, "Usage: /delete <message_id>");
            return;
        }
        const messageId = Number(tokens[1]);
        if (Number.isNaN(messageId) || messageId <= 0) {
            this.sendLine(context.socket, "Message id must be a positive number.");
            return;
        }
        const entry = this.history.getById(messageId);
        if (!entry) {
            this.sendLine(context.socket, `Message #${messageId} not found.`);
            return;
        }
        if (entry.type === "system") {
            this.sendLine(context.socket, "System messages cannot be deleted.");
            return;
        }
        if (entry.sender !== context.name) {
            this.sendLine(context.socket, "You can only delete messages you sent.");
            return;
        }
        if (entry.deleted) {
            this.sendLine(context.socket, "Message already deleted.");
            return;
        }
        const updated = this.history.markDeleted(messageId);
        if (!updated) {
            this.sendLine(context.socket, "Unable to delete message (already removed?).");
            return;
        }
        this.broadcastDeletion(updated, context.name);
        this.sendLine(context.socket, `Deleted message #${messageId}.`);
    }

    private broadcastDeletion(entry: HistoryEntry, by: string): void {
        const payload = this.buildDeletePayload(entry, by);
        if (!payload) {
            return;
        }
        const recipients = new Set(entry.audience ?? []);
        if (entry.type === "group" && entry.group) {
            const members = this.groups.get(entry.group);
            if (members) {
                for (const member of members) {
                    recipients.add(member);
                }
            }
        }
        for (const name of recipients) {
            const targetContext = this.clients.get(name);
            if (targetContext) {
                this.sendLine(targetContext.socket, `DELETE ${JSON.stringify(payload)}`);
            }
        }
    }

    private buildDeletePayload(entry: HistoryEntry, by: string): DeletePayload | undefined {
        if (entry.type !== "private" && entry.type !== "group") {
            return undefined;
        }
        return {
            id: entry.id,
            type: entry.type,
            sender: entry.sender ?? "unknown",
            target: entry.target,
            group: entry.group,
            by,
        };
    }

    private historyEntryVisible(entry: HistoryEntry, requester: string): boolean {
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

    private formatHistoryEntry(entry: HistoryEntry, requester: string): string {
        if (entry.media?.kind === "photo" && !entry.deleted) {
            const payload: PhotoPayload = {
                kind: entry.group ? "group" : "private",
                sender: entry.sender ?? "unknown",
                target: entry.target,
                group: entry.group,
                mime: entry.media.mime,
                name: entry.media.name ?? "photo",
                data: entry.media.data,
                caption:
                    entry.message && entry.message !== "[photo]" ? entry.message : undefined,
                size: entry.media.size,
                timestamp: entry.timestamp,
                id: entry.id,
                deleted: entry.deleted,
            };
            return `PHOTO ${JSON.stringify(payload)}`;
        }
        const timestamp = this.formatTimestamp(entry.timestamp);
        const body = entry.deleted ? "[deleted]" : entry.message;
        if (entry.media?.kind === "photo" && entry.deleted) {
            return `[${timestamp}] [Photo#${entry.id}] ${body}`;
        }
        switch (entry.type) {
            case "private": {
                if (entry.sender === requester) {
                    return `[${timestamp}] [PM -> ${entry.target ?? "unknown"} #${entry.id}] ${body}`;
                }
                return `[${timestamp}] [PM#${entry.id}] ${entry.sender ?? "unknown"}: ${body}`;
            }
            case "group":
                return `[${timestamp}] [Group:${entry.group ?? "unknown"} #${entry.id}] ${
                    entry.sender ?? "unknown"
                }: ${body}`;
            case "system":
            default:
                return `[${timestamp}] [System] ${entry.message}`;
        }
    }

    private formatTimestamp(value: number): string {
        const iso = new Date(value).toISOString();
        return iso.replace("T", " ").slice(0, 19);
    }

    private isGroupMember(name: string, groupName: string): boolean {
        const members = this.groups.get(groupName);
        return !!members && members.has(name);
    }

    private sendLine(socket: Socket, message: string): void {
        if (socket.writable) {
            socket.write(`${message}\n`);
        }
    }

    private entryBody(entry: HistoryEntry): string {
        return entry.deleted ? "[deleted]" : entry.message;
    }

    private renderPrivateIncoming(entry: HistoryEntry): string {
        return `[PM#${entry.id}] ${entry.sender ?? "unknown"}: ${this.entryBody(entry)}`;
    }

    private renderPrivateOutgoing(entry: HistoryEntry): string {
        return `[PM -> ${entry.target ?? "unknown"} #${entry.id}] ${this.entryBody(entry)}`;
    }

    private renderGroupLine(entry: HistoryEntry, isSender: boolean): string {
        const prefix = `[Group:${entry.group ?? "unknown"} #${entry.id}]`;
        if (isSender) {
            return `${prefix} (you): ${this.entryBody(entry)}`;
        }
        return `${prefix} ${entry.sender ?? "unknown"}: ${this.entryBody(entry)}`;
    }
}

interface CliArgs {
    host: string;
    port: number;
}

function parseArgs(argv: string[]): CliArgs {
    let host = DEFAULT_HOST;
    let port = DEFAULT_PORT;

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--host" && i + 1 < argv.length) {
            host = argv[++i];
        } else if ((arg === "--port" || arg === "-p") && i + 1 < argv.length) {
            const value = Number(argv[++i]);
            if (!Number.isNaN(value) && value > 0 && value < 65536) {
                port = value;
            } else {
                console.warn("Invalid port specified; using default.");
            }
        } else if ((arg === "-h" || arg === "--help")) {
            printUsage();
            process.exit(0);
        } else if (arg === "--host") {
            console.warn("Missing value for --host; using default.");
        }
    }

    return { host, port };
}

function printUsage(): void {
    console.log("Usage: ts-node src/server.ts [--host <host>] [--port <port>]");
}

function main(): void {
    const args = parseArgs(process.argv);
    const server = new ChatServer(args.host, args.port);
    server.start();
}

if (require.main === module) {
    main();
}
