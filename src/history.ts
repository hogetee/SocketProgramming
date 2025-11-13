import fs from "node:fs";
import path from "node:path";

export type HistoryEntryType = "system" | "private" | "group";

export interface HistoryMedia {
    kind: "photo";
    mime: string;
    data: string;
    name?: string;
    size: number;
}

export interface HistoryEntry {
    id: number;
    type: HistoryEntryType;
    timestamp: number;
    message: string;
    sender?: string;
    target?: string;
    group?: string;
    audience?: string[];
    media?: HistoryMedia;
    deleted?: boolean;
}

type HistoryInput = Omit<HistoryEntry, "id">;

export class HistoryStore {
    private readonly entries: HistoryEntry[] = [];
    private readonly byId: Map<number, HistoryEntry> = new Map();
    private readonly filePath: string;
    private readonly limit: number;
    private nextId = 1;

    constructor(filePath: string, limit = 500) {
        this.filePath = filePath;
        this.limit = Math.max(limit, 1);
        this.ensureDirectory();
        this.loadExisting();
    }

    public add(entryInput: HistoryInput): HistoryEntry {
        const entry: HistoryEntry = { ...entryInput, id: this.nextId++ };
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

    public getById(id: number): HistoryEntry | undefined {
        return this.byId.get(id);
    }

    public markDeleted(id: number): HistoryEntry | undefined {
        const entry = this.byId.get(id);
        if (!entry || entry.deleted) {
            return undefined;
        }
        entry.deleted = true;
        this.persistAll();
        return entry;
    }

    public getRecent(limit: number, predicate?: (entry: HistoryEntry) => boolean): HistoryEntry[] {
        const max = Math.max(1, limit);
        const result: HistoryEntry[] = [];
        for (let i = this.entries.length - 1; i >= 0 && result.length < max; i -= 1) {
            const entry = this.entries[i];
            if (!predicate || predicate(entry)) {
                result.push(entry);
            }
        }
        return result.reverse();
    }

    private appendToFile(entry: HistoryEntry): void {
        const payload = `${JSON.stringify(entry)}\n`;
        try {
            fs.appendFileSync(this.filePath, payload, "utf8");
        } catch (err) {
            console.error("Failed to write chat history:", err);
        }
    }

    private persistAll(): void {
        const content = `${this.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
        try {
            fs.writeFileSync(this.filePath, content, "utf8");
        } catch (err) {
            console.error("Failed to persist chat history:", err);
        }
    }

    public close(): void {
        // No persistent streams to close; kept for API compatibility.
    }

    private ensureDirectory(): void {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    private loadExisting(): void {
        if (!fs.existsSync(this.filePath)) {
            return;
        }
        try {
            const content = fs.readFileSync(this.filePath, "utf8");
            const lines = content.split(/\r?\n/);
            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }
                try {
                    const entry = JSON.parse(line) as HistoryEntry;
                    if (entry && typeof entry.timestamp === "number" && typeof entry.id === "number") {
                        this.entries.push(entry);
                        this.byId.set(entry.id, entry);
                        this.nextId = Math.max(this.nextId, entry.id + 1);
                    }
                } catch {
                    // Skip malformed lines
                }
            }
            if (this.entries.length > this.limit) {
                const excess = this.entries.splice(0, this.entries.length - this.limit);
                for (const entry of excess) {
                    this.byId.delete(entry.id);
                }
            }
        } catch (err) {
            console.error("Failed to load existing chat history:", err);
        }
    }
}
