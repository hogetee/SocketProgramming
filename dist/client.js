"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_net_1 = __importDefault(require("node:net"));
const node_readline_1 = __importDefault(require("node:readline"));
const node_process_1 = __importDefault(require("node:process"));
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5050;
class ChatClient {
    constructor(host, port, nickname) {
        this.host = host;
        this.port = port;
        this.nickname = nickname;
        this.buffer = "";
        this.shuttingDown = false;
        this.socket = new node_net_1.default.Socket();
        this.rl = node_readline_1.default.createInterface({
            input: node_process_1.default.stdin,
            output: node_process_1.default.stdout,
            prompt: "> ",
        });
    }
    start() {
        this.setupSocket();
        this.setupInput();
        this.socket.connect(this.port, this.host, () => {
            if (this.nickname) {
                this.socket.write(`${this.nickname}\n`);
            }
            this.rl.prompt();
        });
    }
    setupSocket() {
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
    setupInput() {
        this.rl.on("line", (line) => {
            const message = line.trim();
            if (!message) {
                this.rl.prompt();
                return;
            }
            this.socket.write(`${message}\n`);
            if (message.toLowerCase() === "/quit") {
                this.shutdown();
            }
            else {
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
            this.printLine(line);
        }
    }
    printLine(line) {
        if (!line) {
            return;
        }
        node_readline_1.default.clearLine(node_process_1.default.stdout, 0);
        node_readline_1.default.cursorTo(node_process_1.default.stdout, 0);
        node_process_1.default.stdout.write(`${line}\n`);
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
