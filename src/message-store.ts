import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PersistedMessageStatus = "sending" | "pending" | "completed" | "failed";

export interface PersistedMessageRecord {
    message: number;
    requestText: string;
    responseText: string | null;
    detail: string | null;
    status: PersistedMessageStatus;
    read: boolean;
    createdAt: string;
    acceptedAt: string | null;
    completedAt: string | null;
    generationMs: number | null;
}

export interface PersistedChatRecord {
    chat: number;
    temporary: boolean;
    released: boolean;
    nextMessageNumber: number;
    createdAt: string;
    updatedAt: string;
    messages: PersistedMessageRecord[];
}

interface PersistedOwnerMeta {
    ownerId: string;
    nextChatNumber: number;
    createdAt: string;
    updatedAt: string;
}

export interface DurationStats {
    averageGenerationMs: number | null;
    p50Ms: number | null;
    p90Ms: number | null;
    completedCount: number;
}

interface InitializeStoreOptions {
    failInFlightDetail?: string;
    releaseAllChats?: boolean;
}

const RETENTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_MAX_MESSAGES_PER_CHAT = 200;
const now = () => new Date().toISOString();

export class PersistentMessageStore {
    private readonly ownersRootDir: string;

    constructor(
        private readonly dataRootDir: string,
        private readonly namespace: string
    ) {
        this.ownersRootDir = join(this.dataRootDir, "message-store", this.namespace, "owners");
    }

    async initialize(options: InitializeStoreOptions = {}) {
        await mkdir(this.ownersRootDir, { recursive: true });
        const ownerDirectories = await this.listOwnerDirectories();
        const timestamp = now();

        for (const ownerDirectory of ownerDirectories) {
            const ownerId = await this.readOwnerId(ownerDirectory);
            if (!ownerId) {
                continue;
            }

            const chatNumbers = await this.listChatNumbers(ownerId);
            for (const chatNumber of chatNumbers) {
                const chat = await this.readChat(ownerId, chatNumber);
                if (!chat) {
                    continue;
                }

                let changed = false;
                if (options.releaseAllChats && !chat.released) {
                    chat.released = true;
                    changed = true;
                }

                for (const message of chat.messages) {
                    if (message.status !== "sending" && message.status !== "pending") {
                        continue;
                    }

                    message.status = "failed";
                    message.detail = options.failInFlightDetail || "The server restarted before the response was captured.";
                    message.completedAt = timestamp;
                    message.generationMs = null;
                    changed = true;
                }

                if (this.pruneChatMessages(chat)) {
                    changed = true;
                }

                if (!changed) {
                    continue;
                }

                chat.updatedAt = timestamp;
                await this.writeChat(ownerId, chat);
            }
        }
    }

    async createChat(ownerId: string, options: { temporary?: boolean } = {}): Promise<PersistedChatRecord> {
        const meta = await this.readOwnerMeta(ownerId);
        const createdAt = now();
        const chat: PersistedChatRecord = {
            chat: meta.nextChatNumber,
            temporary: Boolean(options.temporary),
            released: false,
            nextMessageNumber: 1,
            createdAt,
            updatedAt: createdAt,
            messages: []
        };

        meta.nextChatNumber += 1;
        meta.updatedAt = createdAt;
        await this.writeOwnerMeta(ownerId, meta);
        await this.writeChat(ownerId, chat);
        return structuredClone(chat);
    }

    async ensureChat(ownerId: string, chatNumber: number, options: { temporary?: boolean; released?: boolean } = {}): Promise<PersistedChatRecord> {
        const existing = await this.readChat(ownerId, chatNumber);
        if (existing) {
            let changed = false;
            if (options.temporary !== undefined && existing.temporary !== Boolean(options.temporary)) {
                existing.temporary = Boolean(options.temporary);
                changed = true;
            }

            if (options.released !== undefined && existing.released !== Boolean(options.released)) {
                existing.released = Boolean(options.released);
                changed = true;
            }

            if (changed) {
                existing.updatedAt = now();
                await this.writeChat(ownerId, existing);
            }

            return structuredClone(existing);
        }

        const createdAt = now();
        const chat: PersistedChatRecord = {
            chat: chatNumber,
            temporary: Boolean(options.temporary),
            released: Boolean(options.released),
            nextMessageNumber: 1,
            createdAt,
            updatedAt: createdAt,
            messages: []
        };
        const meta = await this.readOwnerMeta(ownerId);
        meta.nextChatNumber = Math.max(meta.nextChatNumber, chatNumber + 1);
        meta.updatedAt = createdAt;
        await this.writeOwnerMeta(ownerId, meta);
        await this.writeChat(ownerId, chat);
        return structuredClone(chat);
    }

    async setChatReleased(ownerId: string, chatNumber: number, released: boolean) {
        const chat = await this.requireChat(ownerId, chatNumber);
        chat.released = released;
        chat.updatedAt = now();
        await this.writeChat(ownerId, chat);
        return structuredClone(chat);
    }

    async setChatTemporary(ownerId: string, chatNumber: number, temporary: boolean) {
        const chat = await this.requireChat(ownerId, chatNumber);
        chat.temporary = temporary;
        chat.updatedAt = now();
        await this.writeChat(ownerId, chat);
        return structuredClone(chat);
    }

    async createMessage(ownerId: string, chatNumber: number, requestText: string): Promise<PersistedMessageRecord> {
        const chat = await this.requireChat(ownerId, chatNumber);
        const createdAt = now();
        const message: PersistedMessageRecord = {
            message: chat.nextMessageNumber,
            requestText,
            responseText: null,
            detail: null,
            status: "sending",
            read: false,
            createdAt,
            acceptedAt: null,
            completedAt: null,
            generationMs: null
        };

        chat.nextMessageNumber += 1;
        chat.messages.push(message);
        chat.updatedAt = createdAt;
        this.pruneChatMessages(chat);
        await this.writeChat(ownerId, chat);
        return structuredClone(message);
    }

    async markMessageAccepted(ownerId: string, chatNumber: number, messageNumber: number): Promise<PersistedMessageRecord> {
        const chat = await this.requireChat(ownerId, chatNumber);
        const message = this.requireMessage(chat, messageNumber);
        if (message.status === "sending") {
            message.status = "pending";
            message.acceptedAt = message.acceptedAt || now();
            chat.updatedAt = now();
            await this.writeChat(ownerId, chat);
        }
        return structuredClone(message);
    }

    async completeMessage(
        ownerId: string,
        chatNumber: number,
        messageNumber: number,
        responseText: string,
        detail?: string | null
    ): Promise<PersistedMessageRecord> {
        const chat = await this.requireChat(ownerId, chatNumber);
        const message = this.requireMessage(chat, messageNumber);
        const completedAt = now();
        message.acceptedAt = message.acceptedAt || message.createdAt;
        message.completedAt = completedAt;
        message.responseText = responseText;
        message.detail = detail?.trim() || message.detail;
        message.status = "completed";
        message.generationMs = Math.max(0, Date.parse(completedAt) - Date.parse(message.acceptedAt));
        chat.updatedAt = completedAt;
        this.pruneChatMessages(chat);
        await this.writeChat(ownerId, chat);
        return structuredClone(message);
    }

    async failMessage(ownerId: string, chatNumber: number, messageNumber: number, detail: string): Promise<PersistedMessageRecord> {
        const chat = await this.requireChat(ownerId, chatNumber);
        const message = this.requireMessage(chat, messageNumber);
        const completedAt = now();
        message.completedAt = completedAt;
        message.detail = detail.trim() || message.detail;
        message.status = "failed";
        message.generationMs = null;
        chat.updatedAt = completedAt;
        this.pruneChatMessages(chat);
        await this.writeChat(ownerId, chat);
        return structuredClone(message);
    }

    async markMessageRead(ownerId: string, chatNumber: number, messageNumber: number): Promise<PersistedMessageRecord> {
        const chat = await this.requireChat(ownerId, chatNumber);
        const message = this.requireMessage(chat, messageNumber);
        if (!message.read) {
            message.read = true;
            chat.updatedAt = now();
            await this.writeChat(ownerId, chat);
        }
        return structuredClone(message);
    }

    async getMessage(ownerId: string, chatNumber: number, messageNumber: number): Promise<PersistedMessageRecord | null> {
        const chat = await this.readChat(ownerId, chatNumber);
        if (!chat) {
            return null;
        }

        const message = chat.messages.find((entry) => entry.message === messageNumber) || null;
        return message ? structuredClone(message) : null;
    }

    async listChats(ownerId: string): Promise<PersistedChatRecord[]> {
        const chatNumbers = await this.listChatNumbers(ownerId);
        const chats = await Promise.all(chatNumbers.map((chatNumber) => this.readChat(ownerId, chatNumber)));
        return chats
            .filter((chat): chat is PersistedChatRecord => Boolean(chat))
            .sort((left, right) => left.chat - right.chat)
            .map((chat) => structuredClone(chat));
    }

    async getDurationStats(ownerId?: string | null): Promise<DurationStats> {
        const durations = ownerId ? await this.collectOwnerDurations(ownerId) : await this.collectAllDurations();
        if (durations.length === 0) {
            return {
                averageGenerationMs: null,
                p50Ms: null,
                p90Ms: null,
                completedCount: 0
            };
        }

        const sorted = [...durations].sort((left, right) => left - right);
        const sum = sorted.reduce((accumulator, value) => accumulator + value, 0);
        return {
            averageGenerationMs: Math.round(sum / sorted.length),
            p50Ms: pickPercentile(sorted, 0.5),
            p90Ms: pickPercentile(sorted, 0.9),
            completedCount: sorted.length
        };
    }

    private async collectAllDurations() {
        const ownerDirectories = await this.listOwnerDirectories();
        const durations: number[] = [];
        for (const ownerDirectory of ownerDirectories) {
            const ownerId = await this.readOwnerId(ownerDirectory);
            if (!ownerId) {
                continue;
            }

            durations.push(...await this.collectOwnerDurations(ownerId));
        }

        return durations;
    }

    private async collectOwnerDurations(ownerId: string) {
        const chatNumbers = await this.listChatNumbers(ownerId);
        const durations: number[] = [];
        for (const chatNumber of chatNumbers) {
            const chat = await this.readChat(ownerId, chatNumber);
            if (!chat) {
                continue;
            }

            for (const message of chat.messages) {
                if (message.status !== "completed" || typeof message.generationMs !== "number") {
                    continue;
                }

                durations.push(message.generationMs);
            }
        }

        return durations;
    }

    private async requireChat(ownerId: string, chatNumber: number) {
        const chat = await this.readChat(ownerId, chatNumber);
        if (!chat) {
            throw new Error(`Chat ${chatNumber} was not found for owner ${ownerId}.`);
        }

        return chat;
    }

    private requireMessage(chat: PersistedChatRecord, messageNumber: number) {
        const message = chat.messages.find((entry) => entry.message === messageNumber);
        if (!message) {
            throw new Error(`Message ${messageNumber} was not found in chat ${chat.chat}.`);
        }

        return message;
    }

    private pruneChatMessages(chat: PersistedChatRecord) {
        const cutoffMs = Date.now() - RETENTION_TTL_MS;
        const activeMessages = chat.messages.filter((message) => message.status === "sending" || message.status === "pending");
        let terminalMessages = chat.messages.filter((message) => message.status === "completed" || message.status === "failed");
        terminalMessages = terminalMessages.filter((message) => {
            const timestamp = Date.parse(message.completedAt || message.createdAt);
            return Number.isFinite(timestamp) && timestamp >= cutoffMs;
        });

        terminalMessages.sort((left, right) => left.message - right.message);
        while (activeMessages.length + terminalMessages.length > RETENTION_MAX_MESSAGES_PER_CHAT && terminalMessages.length > 0) {
            terminalMessages.shift();
        }

        const nextMessages = [...terminalMessages, ...activeMessages].sort((left, right) => left.message - right.message);
        const changed = nextMessages.length !== chat.messages.length || nextMessages.some((message, index) => chat.messages[index] !== message);
        chat.messages = nextMessages;
        return changed;
    }

    private async listOwnerDirectories() {
        try {
            const entries = await readdir(this.ownersRootDir, { withFileTypes: true });
            return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        } catch (error) {
            if (isFileNotFound(error)) {
                return [];
            }

            throw error;
        }
    }

    private async readOwnerId(ownerDirectory: string) {
        try {
            const raw = await readFile(join(this.ownersRootDir, ownerDirectory, "meta.json"), "utf8");
            const parsed = JSON.parse(raw) as PersistedOwnerMeta;
            return typeof parsed?.ownerId === "string" ? parsed.ownerId : null;
        } catch (error) {
            if (isFileNotFound(error)) {
                return null;
            }

            throw error;
        }
    }

    private async listChatNumbers(ownerId: string) {
        try {
            const entries = await readdir(this.getOwnerDir(ownerId), { withFileTypes: true });
            return entries
                .filter((entry) => entry.isFile())
                .map((entry) => entry.name.match(/^chat-(\d+)\.json$/)?.[1] || null)
                .filter((value): value is string => Boolean(value))
                .map((value) => Number(value))
                .filter((value) => Number.isInteger(value) && value > 0)
                .sort((left, right) => left - right);
        } catch (error) {
            if (isFileNotFound(error)) {
                return [];
            }

            throw error;
        }
    }

    private async readOwnerMeta(ownerId: string): Promise<PersistedOwnerMeta> {
        try {
            const raw = await readFile(this.getOwnerMetaPath(ownerId), "utf8");
            const parsed = JSON.parse(raw) as PersistedOwnerMeta;
            if (
                parsed &&
                typeof parsed.ownerId === "string" &&
                typeof parsed.nextChatNumber === "number" &&
                typeof parsed.createdAt === "string" &&
                typeof parsed.updatedAt === "string"
            ) {
                return parsed;
            }
        } catch (error) {
            if (!isFileNotFound(error)) {
                throw error;
            }
        }

        const createdAt = now();
        return {
            ownerId,
            nextChatNumber: 1,
            createdAt,
            updatedAt: createdAt
        };
    }

    private async writeOwnerMeta(ownerId: string, meta: PersistedOwnerMeta) {
        await mkdir(this.getOwnerDir(ownerId), { recursive: true });
        await writeFile(this.getOwnerMetaPath(ownerId), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    }

    private async readChat(ownerId: string, chatNumber: number): Promise<PersistedChatRecord | null> {
        try {
            const raw = await readFile(this.getChatPath(ownerId, chatNumber), "utf8");
            const parsed = JSON.parse(raw) as PersistedChatRecord;
            if (
                !parsed ||
                typeof parsed.chat !== "number" ||
                typeof parsed.temporary !== "boolean" ||
                typeof parsed.released !== "boolean" ||
                typeof parsed.nextMessageNumber !== "number" ||
                !Array.isArray(parsed.messages)
            ) {
                return null;
            }

            return parsed;
        } catch (error) {
            if (isFileNotFound(error)) {
                return null;
            }

            throw error;
        }
    }

    private async writeChat(ownerId: string, chat: PersistedChatRecord) {
        await mkdir(this.getOwnerDir(ownerId), { recursive: true });
        await writeFile(this.getChatPath(ownerId, chat.chat), `${JSON.stringify(chat, null, 2)}\n`, "utf8");
    }

    private getOwnerDir(ownerId: string) {
        return join(this.ownersRootDir, sanitizeFileSegment(ownerId));
    }

    private getOwnerMetaPath(ownerId: string) {
        return join(this.getOwnerDir(ownerId), "meta.json");
    }

    private getChatPath(ownerId: string, chatNumber: number) {
        return join(this.getOwnerDir(ownerId), `chat-${chatNumber}.json`);
    }
}

function pickPercentile(sortedValues: number[], percentile: number) {
    const index = Math.max(0, Math.ceil(sortedValues.length * percentile) - 1);
    return sortedValues[index] ?? null;
}

function sanitizeFileSegment(value: string) {
    return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function isFileNotFound(error: unknown) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
