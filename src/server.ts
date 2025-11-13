import net, { Socket } from "node:net";
import process from "node:process";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 5050;

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
    private shuttingDown = false;

    constructor(host: string, port: number) {
        this.host = host;
        this.port = port;
        this.server = net.createServer((socket) => this.handleConnection(socket));
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
        };

        this.server.on("error", (err) => {
            console.error("Server error:", err.message);
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
        this.sendLine(recipient.socket, `[PM] ${sender}: ${message}`);
        this.sendLine(origin, `[PM -> ${target}] ${message}`);
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
    }

    private broadcastSystem(message: string): void {
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

    private sendLine(socket: Socket, message: string): void {
        if (socket.writable) {
            socket.write(`${message}\n`);
        }
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
