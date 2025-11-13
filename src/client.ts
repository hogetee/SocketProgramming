import net, { Socket } from "node:net";
import readline from "node:readline";
import process from "node:process";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5050;

type RoomType = "system" | "private" | "group";

interface RoomState {
    id: string;
    label: string;
    type: RoomType;
    target?: string;
    history: string[];
    unread: number;
}

interface CliArgs {
    host: string;
    port: number;
    name?: string;
}

class ChatClient {
    private readonly socket: Socket;
    private readonly rl: readline.Interface;
    private buffer = "";
    private shuttingDown = false;
    private readonly rooms: Map<string, RoomState> = new Map();
    private activeRoomId: string;
    private readonly historyLimit = 200;
    private readyForRooms = false;
    private roomInstructionsShown = false;
    private userNickname?: string;

    constructor(
        private readonly host: string,
        private readonly port: number,
        private readonly nickname?: string
    ) {
        this.socket = new net.Socket();
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: "> ",
        });
        const systemRoom = this.ensureRoom("system", "system");
        this.activeRoomId = systemRoom.id;
        this.renderActiveRoom();
    }

    public start(): void {
        this.setupSocket();
        this.setupInput();
        this.socket.connect(this.port, this.host, () => {
            this.appendSystemMessage(`Connected to ${this.host}:${this.port}.`);
            if (this.nickname) {
                this.socket.write(`${this.nickname}\n`);
            }
        });
    }

    private setupSocket(): void {
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

    private setupInput(): void {
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
                } else {
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

    private handleIncomingData(chunk: string | Buffer): void {
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

    private routeServerLine(line: string): void {
        if (!line.trim()) {
            return;
        }

        const privateIncoming = line.match(/^\[PM\]\s+([^:]+):\s*(.*)$/);
        if (privateIncoming) {
            const [, sender, body] = privateIncoming;
            const room = this.ensureRoom("private", sender);
            this.appendMessage(room, `${sender}: ${body}`);
            return;
        }

        const privateOutgoing = line.match(/^\[PM -> ([^\]]+)\]\s*(.*)$/);
        if (privateOutgoing) {
            const [, target, body] = privateOutgoing;
            const room = this.ensureRoom("private", target);
            this.appendMessage(room, `(you): ${body}`);
            return;
        }

        const groupMatch = line.match(/^\[Group:([^\]]+)\]\s+(.*)$/);
        if (groupMatch) {
            const [, groupName, rest] = groupMatch;
            const room = this.ensureRoom("group", groupName);
            const colonIndex = rest.indexOf(":");
            if (colonIndex === -1) {
                this.appendMessage(room, rest.trim());
            } else {
                const speaker = rest.slice(0, colonIndex).trim();
                const body = rest.slice(colonIndex + 1).trim();
                this.appendMessage(room, `${speaker}: ${body}`);
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
                this.appendSystemMessage(
                    "Chat rooms unlocked. Use /chat @nickname or /chat #group to focus a room."
                );
                this.appendSystemMessage(
                    "While a room is active, type messages without commands to use its chat box."
                );
            }
        }
    }

    private detectGroupRoomHints(line: string): void {
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

    private handleLocalCommand(input: string): boolean {
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

    private listRooms(): void {
        const lines = [...this.rooms.values()]
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((room) => {
                const active = room.id === this.activeRoomId ? "*" : " ";
                const unread = room.unread > 0 ? ` (${room.unread} new)` : "";
                return `${active} ${room.label} [${room.type}]${unread}`;
            });
        if (lines.length === 0) {
            this.statusLine("No rooms open.");
        } else {
            this.statusLine(lines.join("\n"));
        }
    }

    private openRoomUsingIdentifier(identifierRaw: string): void {
        const identifier = identifierRaw.trim();
        if (!identifier) {
            this.statusLine("Usage: /chat <@nickname|#group>");
            return;
        }
        let room: RoomState;
        if (identifier === "system" || identifier === "!system") {
            room = this.getSystemRoom();
        } else if (identifier.startsWith("#")) {
            room = this.ensureRoom("group", identifier.slice(1));
        } else {
            const target = identifier.startsWith("@") ? identifier.slice(1) : identifier;
            if (!target) {
                this.statusLine("Provide a nickname after /chat.");
                return;
            }
            room = this.ensureRoom("private", target);
        }
        this.focusRoom(room.id);
    }

    private focusRoom(roomId: string): void {
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

    private sendToActiveRoom(message: string): boolean {
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
        } else if (room.type === "group") {
            this.socket.write(`/group send ${room.target} ${message}\n`);
        }
        this.promptActive();
        return true;
    }

    private appendSystemMessage(text: string): void {
        const room = this.getSystemRoom();
        this.appendMessage(room, text);
    }

    private appendMessage(room: RoomState, text: string): void {
        room.history.push(text);
        if (room.history.length > this.historyLimit) {
            room.history.shift();
        }
        if (room.id === this.activeRoomId) {
            this.renderActiveRoom();
        } else {
            room.unread += 1;
            this.statusLine(
                `[${room.label}] ${room.unread} new message(s). Use /chat ${room.label} to view.`
            );
        }
    }

    private ensureRoom(type: RoomType, identifier: string): RoomState {
        let id: string;
        let label: string;
        let target: string | undefined;
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

    private seedRoom(room: RoomState): void {
        if (room.type === "system") {
            room.history.push("[info] System room active. Server prompts will appear here.");
            room.history.push(
                "Enter your nickname to join. Use /chat @nickname or /chat #group once greeted."
            );
        } else if (room.type === "private" && room.target) {
            room.history.push(`[info] Private chat with ${room.target}. Type to send messages.`);
        } else if (room.type === "group" && room.target) {
            room.history.push(`[info] Group chat ${room.label}. Type to talk to members.`);
        }
    }

    private getSystemRoom(): RoomState {
        return this.ensureRoom("system", "system");
    }

    private renderActiveRoom(): void {
        const room = this.rooms.get(this.activeRoomId);
        if (!room) {
            return;
        }
        room.unread = 0;
        if (typeof console.clear === "function") {
            console.clear();
        } else {
            process.stdout.write("\x1Bc");
        }
        console.log(`Room ${room.label} (${room.type})`);
        console.log("-".repeat(60));
        const history = room.history.slice(-this.historyLimit);
        if (history.length === 0) {
            console.log("(No messages yet. Use /chat to switch rooms or start typing.)");
        } else {
            for (const entry of history) {
                console.log(entry);
            }
        }
        console.log("-".repeat(60));
        this.rl.setPrompt(`${room.label}> `);
        this.promptActive();
    }

    private statusLine(message: string): void {
        if (this.shuttingDown) {
            return;
        }
        const lines = message.split("\n");
        for (const line of lines) {
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(`${line}\n`);
        }
        this.promptActive();
    }

    private promptActive(): void {
        if (!this.shuttingDown) {
            this.rl.prompt();
        }
    }

    private shutdown(exitCode = 0): void {
        if (this.shuttingDown) {
            return;
        }
        this.shuttingDown = true;
        this.rl.pause();
        if (!this.socket.destroyed) {
            this.socket.end();
            this.socket.destroy();
        }
        process.exitCode = exitCode;
    }
}

function parseArgs(argv: string[]): CliArgs {
    let host = DEFAULT_HOST;
    let port = DEFAULT_PORT;
    let name: string | undefined;

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--host" && i + 1 < argv.length) {
            host = argv[++i];
        } else if ((arg === "--port" || arg === "-p") && i + 1 < argv.length) {
            const value = Number(argv[++i]);
            if (!Number.isNaN(value) && value > 0 && value < 65536) {
                port = value;
            } else {
                console.warn("Invalid port specified; using default 5050.");
            }
        } else if (arg === "--name" && i + 1 < argv.length) {
            name = argv[++i];
        } else if (arg === "--help" || arg === "-h") {
            printUsage();
            process.exit(0);
        } else {
            console.warn(`Ignoring unknown argument: ${arg}`);
        }
    }

    return { host, port, name };
}

function printUsage(): void {
    console.log(
        "Usage: ts-node src/client.ts [--host <host>] [--port <port>] [--name <nickname>]"
    );
}

function main(): void {
    const args = parseArgs(process.argv);
    const client = new ChatClient(args.host, args.port, args.name);
    client.start();
}

if (require.main === module) {
    main();
}
