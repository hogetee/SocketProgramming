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
        this.byId = new Map();
        this.nextId = 1;
        this.filePath = filePath;
        this.limit = Math.max(limit, 1);
        this.ensureDirectory();
        this.loadExisting();
    }
    add(entryInput) {
        const entry = { ...entryInput, id: this.nextId++ };
        this.entries.push(entry);
        this.byId.set(entry.id, entry);
        if (this.entries.length > this.limit) {
            const removed = this.entries.splice(0, this.entries.length - this.limit);
            for (const item of removed) {
                this.byId.delete(item.id);
            }
        }
        this.appendToFile(entry);
        return entry;
    }
    getById(id) {
        return this.byId.get(id);
    }
    markDeleted(id) {
        const entry = this.byId.get(id);
        if (!entry || entry.deleted) {
            return undefined;
        }
        entry.deleted = true;
        this.persistAll();
        return entry;
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
    appendToFile(entry) {
        const payload = `${JSON.stringify(entry)}\n`;
        try {
            node_fs_1.default.appendFileSync(this.filePath, payload, "utf8");
        }
        catch (err) {
            console.error("Failed to write chat history:", err);
        }
    }
    persistAll() {
        const content = `${this.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
        try {
            node_fs_1.default.writeFileSync(this.filePath, content, "utf8");
        }
        catch (err) {
            console.error("Failed to persist chat history:", err);
        }
    }
    close() {
        // No persistent streams to close; kept for API compatibility.
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
                    if (entry && typeof entry.timestamp === "number" && typeof entry.id === "number") {
                        this.entries.push(entry);
                        this.byId.set(entry.id, entry);
                        this.nextId = Math.max(this.nextId, entry.id + 1);
                    }
                }
                catch {
                    // Skip malformed lines
                }
            }
            if (this.entries.length > this.limit) {
                const excess = this.entries.splice(0, this.entries.length - this.limit);
                for (const entry of excess) {
                    this.byId.delete(entry.id);
                }
            }
        }
        catch (err) {
            console.error("Failed to load existing chat history:", err);
        }
    }
}
exports.HistoryStore = HistoryStore;
