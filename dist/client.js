"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_net_1 = __importDefault(require("node:net"));
const node_path_1 = __importDefault(require("node:path"));
const node_readline_1 = __importDefault(require("node:readline"));
const node_process_1 = __importDefault(require("node:process"));
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5050;
const MEDIA_DIR = node_path_1.default.resolve(node_process_1.default.cwd(), "received-photos");
class ChatClient {
    constructor(host, port, nickname) {
        this.host = host;
        this.port = port;
        this.nickname = nickname;
        this.buffer = "";
        this.shuttingDown = false;
        this.rooms = new Map();
        this.historyLimit = 200;
        this.readyForRooms = false;
        this.roomInstructionsShown = false;
        this.mediaDir = MEDIA_DIR;
        this.mediaDirReady = false;
        this.socket = new node_net_1.default.Socket();
        this.rl = node_readline_1.default.createInterface({
            input: node_process_1.default.stdin,
            output: node_process_1.default.stdout,
            prompt: "> ",
        });
        const systemRoom = this.ensureRoom("system", "system");
        this.activeRoomId = systemRoom.id;
        this.renderActiveRoom();
    }
    start() {
        this.setupSocket();
        this.setupInput();
        this.socket.connect(this.port, this.host, () => {
            this.appendSystemMessage(`Connected to ${this.host}:${this.port}.`);
            if (this.nickname) {
                this.socket.write(`${this.nickname}\n`);
            }
        });
    }
    setupSocket() {
        this.socket.setEncoding("utf8");
        this.socket.on("data", (chunk) => this.handleIncomingData(chunk));
        this.socket.on("close", () => {
            this.appendSystemMessage("[Disconnected from server]");
            this.shutdown();
        });
        this.socket.on("error", (err) => {
            this.appendSystemMessage(`Connection error: ${err.message}`);
            this.shutdown(1);
        });
    }
    setupInput() {
        this.rl.on("line", (line) => {
            const message = line.trim();
            if (!message) {
                this.promptActive();
                return;
            }
            if (!this.readyForRooms) {
                this.socket.write(`${message}\n`);
                if (message.toLowerCase() === "/quit") {
                    this.shutdown();
                }
                else {
                    this.promptActive();
                }
                return;
            }
            if (this.handleLocalCommand(message)) {
                return;
            }
            if (message.toLowerCase() === "/quit") {
                this.socket.write("/quit\n");
                this.shutdown();
                return;
            }
            if (message.startsWith("/")) {
                this.socket.write(`${message}\n`);
                this.promptActive();
                return;
            }
            if (!this.sendToActiveRoom(message)) {
                this.promptActive();
            }
        });
        this.rl.on("SIGINT", () => {
            if (this.shuttingDown) {
                this.rl.close();
                return;
            }
            this.socket.write("/quit\n");
            this.shutdown();
        });
        this.rl.on("close", () => {
            this.shutdown();
        });
    }
    handleIncomingData(chunk) {
        this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        while (true) {
            const newlineIndex = this.buffer.indexOf("\n");
            if (newlineIndex === -1) {
                break;
            }
            const rawLine = this.buffer.slice(0, newlineIndex);
            this.buffer = this.buffer.slice(newlineIndex + 1);
            const line = rawLine.replace(/\r$/, "");
            this.routeServerLine(line);
        }
    }
    routeServerLine(line) {
        if (!line.trim()) {
            return;
        }
        if (line.startsWith("PHOTO ")) {
            this.processPhotoLine(line.slice(6));
            return;
        }
        if (line.startsWith("DELETE ")) {
            this.processDeleteLine(line.slice(7));
            return;
        }
        const privateIncoming = line.match(/^\[PM(?:#(\d+))?\]\s+([^:]+):\s*(.*)$/);
        if (privateIncoming) {
            const [, idRaw, sender, body] = privateIncoming;
            const room = this.ensureRoom("private", sender);
            this.appendMessage(room, `${sender}: ${body} ${idRaw ? `(id:${idRaw})` : ""}`.trim());
            return;
        }
        const privateOutgoing = line.match(/^\[PM -> ([^\]\s]+)(?:\s+#(\d+))?\]\s*(.*)$/);
        if (privateOutgoing) {
            const [, target, idRaw, body] = privateOutgoing;
            const room = this.ensureRoom("private", target);
            const suffix = idRaw ? ` (id:${idRaw})` : "";
            this.appendMessage(room, `(you): ${body}${suffix}`);
            return;
        }
        const groupMatch = line.match(/^\[Group:([^\]#]+)(?:\s*#(\d+))?\]\s+(.*)$/);
        if (groupMatch) {
            const [, groupName, idRaw, rest] = groupMatch;
            const room = this.ensureRoom("group", groupName);
            const colonIndex = rest.indexOf(":");
            if (colonIndex === -1) {
                this.appendMessage(room, `${rest.trim()}${idRaw ? ` (id:${idRaw})` : ""}`);
            }
            else {
                const speaker = rest.slice(0, colonIndex).trim();
                const body = rest.slice(colonIndex + 1).trim();
                const suffix = idRaw ? ` (id:${idRaw})` : "";
                this.appendMessage(room, `${speaker}: ${body}${suffix}`);
            }
            return;
        }
        this.detectGroupRoomHints(line);
        this.appendSystemMessage(line);
        const helloMatch = line.match(/^Hello\s+([A-Za-z0-9_]+)!/);
        if (helloMatch) {
            this.userNickname = helloMatch[1];
            this.readyForRooms = true;
            if (!this.roomInstructionsShown) {
                this.roomInstructionsShown = true;
                this.appendSystemMessage("Chat rooms unlocked. Use /chat @nickname or /chat #group to focus a room.");
                this.appendSystemMessage("While a room is active, type messages without commands to use its chat box.");
            }
        }
    }
    detectGroupRoomHints(line) {
        const createdMatch = line.match(/^Created group ([A-Za-z0-9_]+) and joined it\./);
        if (createdMatch) {
            const room = this.ensureRoom("group", createdMatch[1]);
            this.appendMessage(room, "[info] You created this group.");
            return;
        }
        const joinedMatch = line.match(/^Joined group ([A-Za-z0-9_]+)\./);
        if (joinedMatch) {
            const room = this.ensureRoom("group", joinedMatch[1]);
            this.appendMessage(room, "[info] You joined this group.");
        }
    }
    handleLocalCommand(input) {
        const tokens = input.split(/\s+/);
        const command = tokens[0].toLowerCase();
        switch (command) {
            case "/rooms":
                this.listRooms();
                return true;
            case "/chat":
            case "/use":
                this.openRoomUsingIdentifier(tokens.slice(1).join(" "));
                return true;
            case "/system":
                this.focusRoom("!system");
                return true;
            default:
                return false;
        }
    }
    listRooms() {
        const lines = [...this.rooms.values()]
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((room) => {
            const active = room.id === this.activeRoomId ? "*" : " ";
            const unread = room.unread > 0 ? ` (${room.unread} new)` : "";
            return `${active} ${room.label} [${room.type}]${unread}`;
        });
        if (lines.length === 0) {
            this.statusLine("No rooms open.");
        }
        else {
            this.statusLine(lines.join("\n"));
        }
    }
    openRoomUsingIdentifier(identifierRaw) {
        const identifier = identifierRaw.trim();
        if (!identifier) {
            this.statusLine("Usage: /chat <@nickname|#group>");
            return;
        }
        let room;
        if (identifier === "system" || identifier === "!system") {
            room = this.getSystemRoom();
        }
        else if (identifier.startsWith("#")) {
            room = this.ensureRoom("group", identifier.slice(1));
        }
        else {
            const target = identifier.startsWith("@") ? identifier.slice(1) : identifier;
            if (!target) {
                this.statusLine("Provide a nickname after /chat.");
                return;
            }
            room = this.ensureRoom("private", target);
        }
        this.focusRoom(room.id);
    }
    focusRoom(roomId) {
        if (!roomId) {
            return;
        }
        const room = this.rooms.get(roomId);
        if (!room) {
            this.statusLine(`Room ${roomId} is not available yet.`);
            return;
        }
        this.activeRoomId = room.id;
        this.renderActiveRoom();
    }
    sendToActiveRoom(message) {
        if (!this.readyForRooms) {
            this.statusLine("Wait until you join the server before sending messages.");
            return false;
        }
        const room = this.rooms.get(this.activeRoomId);
        if (!room) {
            this.statusLine("No active room selected.");
            return false;
        }
        if (room.type === "system" || !room.target) {
            this.statusLine("Use /chat @nickname or /chat #group to choose a chat room first.");
            return false;
        }
        if (room.type === "private") {
            this.socket.write(`/msg ${room.target} ${message}\n`);
        }
        else if (room.type === "group") {
            this.socket.write(`/group send ${room.target} ${message}\n`);
        }
        this.promptActive();
        return true;
    }
    appendSystemMessage(text) {
        const room = this.getSystemRoom();
        this.appendMessage(room, text);
    }
    processPhotoLine(raw) {
        try {
            const payload = JSON.parse(raw);
            this.handlePhotoPayload(payload);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.appendSystemMessage(`[warn] Failed to parse incoming photo: ${message}`);
        }
    }
    processDeleteLine(raw) {
        try {
            const payload = JSON.parse(raw);
            this.handleDeletePayload(payload);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.appendSystemMessage(`[warn] Failed to parse delete event: ${message}`);
        }
    }
    handlePhotoPayload(payload) {
        if (!payload || !payload.mime || !payload.data) {
            this.appendSystemMessage("[warn] Photo payload missing data.");
            return;
        }
        const roomType = payload.kind === "group" ? "group" : "private";
        let identifier;
        if (roomType === "group") {
            if (!payload.group) {
                this.appendSystemMessage("[warn] Photo payload missing group name.");
                return;
            }
            identifier = payload.group;
        }
        else if (payload.sender && payload.sender === this.userNickname) {
            identifier = payload.target ?? payload.sender;
        }
        else {
            identifier = payload.sender ?? payload.target;
        }
        if (!identifier) {
            this.appendSystemMessage("[warn] Photo payload missing target.");
            return;
        }
        const room = this.ensureRoom(roomType, identifier);
        const caption = payload.caption ? ` ${payload.caption}` : "";
        let summary;
        if (roomType === "group") {
            summary = `[photo:${payload.mime}] ${payload.sender ?? "unknown"} -> #${payload.group}${caption}`;
        }
        else if (payload.sender === this.userNickname) {
            summary = `[photo:${payload.mime}] (you -> ${payload.target ?? "unknown"})${caption}`;
        }
        else {
            summary = `[photo:${payload.mime}] ${payload.sender ?? "unknown"}${caption}`;
        }
        const savedPath = this.savePhotoToDisk(payload);
        const info = savedPath ? `${summary} saved to ${savedPath}` : `${summary} (save failed)`;
        this.appendMessage(room, info);
    }
    handleDeletePayload(payload) {
        if (!payload || !payload.id) {
            this.appendSystemMessage("[warn] Delete payload missing id.");
            return;
        }
        const roomType = payload.type === "group" ? "group" : "private";
        let identifier;
        if (roomType === "group") {
            identifier = payload.group;
        }
        else if (payload.sender === this.userNickname) {
            identifier = payload.target ?? payload.sender;
        }
        else if (payload.target === this.userNickname) {
            identifier = payload.sender;
        }
        else {
            identifier = payload.sender ?? payload.target;
        }
        const room = identifier ? this.ensureRoom(roomType, identifier) : this.getSystemRoom();
        const message = `[info] Message #${payload.id} deleted by ${payload.by ?? "sender"} ` +
            `${roomType === "group" ? `(group ${payload.group ?? "unknown"})` : ""}`.trim();
        this.appendMessage(room, message);
    }
    savePhotoToDisk(payload) {
        try {
            const buffer = Buffer.from(payload.data, "base64");
            if (!buffer.length) {
                return undefined;
            }
            this.ensureMediaDir();
            const fileName = this.buildPhotoFileName(payload);
            const filePath = node_path_1.default.join(this.mediaDir, fileName);
            node_fs_1.default.writeFileSync(filePath, buffer);
            return filePath;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.appendSystemMessage(`[warn] Failed to save photo: ${message}`);
            return undefined;
        }
    }
    ensureMediaDir() {
        if (this.mediaDirReady) {
            return;
        }
        node_fs_1.default.mkdirSync(this.mediaDir, { recursive: true });
        this.mediaDirReady = true;
    }
    buildPhotoFileName(payload) {
        const rawName = payload.name && /^[A-Za-z0-9._-]+$/.test(payload.name) ? payload.name : "photo";
        const existingExt = node_path_1.default.extname(rawName);
        const extension = existingExt || this.extensionFromMime(payload.mime);
        const stemSource = existingExt ? rawName.slice(0, -existingExt.length) : rawName;
        const safeStem = stemSource.replace(/[^A-Za-z0-9._-]+/g, "_") || "photo";
        const stamp = payload.timestamp ? new Date(payload.timestamp).getTime() : Date.now();
        return `${safeStem}_${stamp}${extension || ".img"}`;
    }
    extensionFromMime(mime) {
        if (mime === "image/png") {
            return ".png";
        }
        if (mime === "image/jpeg") {
            return ".jpg";
        }
        if (mime === "image/gif") {
            return ".gif";
        }
        return ".img";
    }
    appendMessage(room, text) {
        room.history.push(text);
        if (room.history.length > this.historyLimit) {
            room.history.shift();
        }
        if (room.id === this.activeRoomId) {
            this.renderActiveRoom();
        }
        else {
            room.unread += 1;
            this.statusLine(`[${room.label}] ${room.unread} new message(s). Use /chat ${room.label} to view.`);
        }
    }
    ensureRoom(type, identifier) {
        let id;
        let label;
        let target;
        const normalized = identifier.trim();
        switch (type) {
            case "system":
                id = "!system";
                label = "system";
                break;
            case "private":
                id = `@${normalized}`;
                label = `@${normalized}`;
                target = normalized;
                break;
            case "group":
                id = `#${normalized}`;
                label = `#${normalized}`;
                target = normalized;
                break;
            default:
                id = normalized;
                label = normalized;
        }
        let room = this.rooms.get(id);
        if (!room) {
            room = { id, label, type, target, history: [], unread: 0 };
            this.rooms.set(id, room);
            this.seedRoom(room);
        }
        return room;
    }
    seedRoom(room) {
        if (room.type === "system") {
            room.history.push("[info] System room active. Server prompts will appear here.");
            room.history.push("Enter your nickname to join. Use /chat @nickname or /chat #group once greeted.");
        }
        else if (room.type === "private" && room.target) {
            room.history.push(`[info] Private chat with ${room.target}. Type to send messages.`);
        }
        else if (room.type === "group" && room.target) {
            room.history.push(`[info] Group chat ${room.label}. Type to talk to members.`);
        }
    }
    getSystemRoom() {
        return this.ensureRoom("system", "system");
    }
    renderActiveRoom() {
        const room = this.rooms.get(this.activeRoomId);
        if (!room) {
            return;
        }
        room.unread = 0;
        if (typeof console.clear === "function") {
            console.clear();
        }
        else {
            node_process_1.default.stdout.write("\x1Bc");
        }
        console.log(`Room ${room.label} (${room.type})`);
        console.log("-".repeat(60));
        const history = room.history.slice(-this.historyLimit);
        if (history.length === 0) {
            console.log("(No messages yet. Use /chat to switch rooms or start typing.)");
        }
        else {
            for (const entry of history) {
                console.log(entry);
            }
        }
        console.log("-".repeat(60));
        this.rl.setPrompt(`${room.label}> `);
        this.promptActive();
    }
    statusLine(message) {
        if (this.shuttingDown) {
            return;
        }
        const lines = message.split("\n");
        for (const line of lines) {
            node_readline_1.default.clearLine(node_process_1.default.stdout, 0);
            node_readline_1.default.cursorTo(node_process_1.default.stdout, 0);
            node_process_1.default.stdout.write(`${line}\n`);
        }
        this.promptActive();
    }
    promptActive() {
        if (!this.shuttingDown) {
            this.rl.prompt();
        }
    }
    shutdown(exitCode = 0) {
        if (this.shuttingDown) {
            return;
        }
        this.shuttingDown = true;
        this.rl.pause();
        if (!this.socket.destroyed) {
            this.socket.end();
            this.socket.destroy();
        }
        node_process_1.default.exitCode = exitCode;
    }
}
function parseArgs(argv) {
    let host = DEFAULT_HOST;
    let port = DEFAULT_PORT;
    let name;
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
                console.warn("Invalid port specified; using default 5050.");
            }
        }
        else if (arg === "--name" && i + 1 < argv.length) {
            name = argv[++i];
        }
        else if (arg === "--help" || arg === "-h") {
            printUsage();
            node_process_1.default.exit(0);
        }
        else {
            console.warn(`Ignoring unknown argument: ${arg}`);
        }
    }
    return { host, port, name };
}
function printUsage() {
    console.log("Usage: ts-node src/client.ts [--host <host>] [--port <port>] [--name <nickname>]");
}
function main() {
    const args = parseArgs(node_process_1.default.argv);
    const client = new ChatClient(args.host, args.port, args.name);
    client.start();
}
if (require.main === module) {
    main();
}
