import fs from "node:fs";
import path from "node:path";

export type HistoryEntryType = "system" | "private" | "group";

export interface HistoryEntry {
    type: HistoryEntryType;
    timestamp: number;
    message: string;
    sender?: string;
    target?: string;
    group?: string;
    audience?: string[];
}

export class HistoryStore {
    private readonly entries: HistoryEntry[] = [];
    private readonly filePath: string;
    private readonly limit: number;
    private writeStream?: fs.WriteStream;

    constructor(filePath: string, limit = 500) {
        this.filePath = filePath;
        this.limit = Math.max(limit, 1);
        this.ensureDirectory();
        this.loadExisting();
        this.writeStream = fs.createWriteStream(this.filePath, { flags: "a" });
    }

    public append(entry: HistoryEntry): void {
        this.entries.push(entry);
        if (this.entries.length > this.limit) {
            this.entries.splice(0, this.entries.length - this.limit);
        }
        const payload = `${JSON.stringify(entry)}\n`;
        try {
            this.writeStream?.write(payload);
        } catch (err) {
            console.error("Failed to write chat history:", err);
        }
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

    public close(): void {
        if (this.writeStream) {
            this.writeStream.end();
            this.writeStream = undefined;
        }
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
                    if (entry && typeof entry.timestamp === "number") {
                        this.entries.push(entry);
                    }
                } catch {
                    // Skip malformed lines
                }
            }
            if (this.entries.length > this.limit) {
                this.entries.splice(0, this.entries.length - this.limit);
            }
        } catch (err) {
            console.error("Failed to load existing chat history:", err);
        }
    }
}
