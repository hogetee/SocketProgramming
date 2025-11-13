import net, { Socket } from "node:net";
import readline from "node:readline";
import process from "node:process";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5050;

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

    constructor(private readonly host: string, private readonly port: number, private readonly nickname?: string) {
        this.socket = new net.Socket();
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: "> ",
        });
    }

    public start(): void {
        this.setupSocket();
        this.setupInput();
        this.socket.connect(this.port, this.host, () => {
            if (this.nickname) {
                this.socket.write(`${this.nickname}\n`);
            }
            this.rl.prompt();
        });
    }

    private setupSocket(): void {
        this.socket.setEncoding("utf8");
        this.socket.on("data", (chunk) => this.handleIncomingData(chunk));
        this.socket.on("close", () => {
            this.printLine("[Disconnected from server]");
            this.shutdown();
        });
        this.socket.on("error", (err) => {
            this.printLine(`Connection error: ${err.message}`);
            this.shutdown(1);
        });
    }

    private setupInput(): void {
        this.rl.on("line", (line) => {
            const message = line.trim();
            if (!message) {
                this.rl.prompt();
                return;
            }
            this.socket.write(`${message}\n`);
            if (message.toLowerCase() === "/quit") {
                this.shutdown();
            } else {
                this.rl.prompt();
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
            this.printLine(line);
        }
    }

    private printLine(line: string): void {
        if (!line) {
            return;
        }
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`${line}\n`);
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
    console.log("Usage: ts-node src/client.ts [--host <host>] [--port <port>] [--name <nickname>]");
}

function main(): void {
    const args = parseArgs(process.argv);
    const client = new ChatClient(args.host, args.port, args.name);
    client.start();
}

if (require.main === module) {
    main();
}
