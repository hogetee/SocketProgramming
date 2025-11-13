"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HistoryStore = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
class HistoryStore {
    constructor(filePath, limit = 500) {
        this.entries = [];
        this.filePath = filePath;
        this.limit = Math.max(limit, 1);
        this.ensureDirectory();
        this.loadExisting();
        this.writeStream = node_fs_1.default.createWriteStream(this.filePath, { flags: "a" });
    }
    append(entry) {
        this.entries.push(entry);
        if (this.entries.length > this.limit) {
            this.entries.splice(0, this.entries.length - this.limit);
        }
        const payload = `${JSON.stringify(entry)}\n`;
        try {
            this.writeStream?.write(payload);
        }
        catch (err) {
            console.error("Failed to write chat history:", err);
        }
    }
    getRecent(limit, predicate) {
        const max = Math.max(1, limit);
        const result = [];
        for (let i = this.entries.length - 1; i >= 0 && result.length < max; i -= 1) {
            const entry = this.entries[i];
            if (!predicate || predicate(entry)) {
                result.push(entry);
            }
        }
        return result.reverse();
    }
    close() {
        if (this.writeStream) {
            this.writeStream.end();
            this.writeStream = undefined;
        }
    }
    ensureDirectory() {
        const dir = node_path_1.default.dirname(this.filePath);
        if (!node_fs_1.default.existsSync(dir)) {
            node_fs_1.default.mkdirSync(dir, { recursive: true });
        }
    }
    loadExisting() {
        if (!node_fs_1.default.existsSync(this.filePath)) {
            return;
        }
        try {
            const content = node_fs_1.default.readFileSync(this.filePath, "utf8");
            const lines = content.split(/\r?\n/);
            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }
                try {
                    const entry = JSON.parse(line);
                    if (entry && typeof entry.timestamp === "number") {
                        this.entries.push(entry);
                    }
                }
                catch {
                    // Skip malformed lines
                }
            }
            if (this.entries.length > this.limit) {
                this.entries.splice(0, this.entries.length - this.limit);
            }
        }
        catch (err) {
            console.error("Failed to load existing chat history:", err);
        }
    }
}
exports.HistoryStore = HistoryStore;
