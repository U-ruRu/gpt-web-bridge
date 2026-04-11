import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHATGPT_HOME_URL, HttpError, type ChatMode } from "../bridge/types.js";
import { PersistentMessageStore, type PersistedChatRecord, type PersistedMessageRecord } from "../message-store.js";
import type {
    AgentSessionAskAcceptedMessage,
    AgentSessionAskResultMessage,
    AgentSessionCommandResultMessage,
    AgentSessionReadyMessage,
    AgentSessionReleasedMessage,
    AgentToServerMessage,
    ConnectedAgentRecord,
    McpBindingRecord,
    RemoteAskAsyncResult,
    RemoteAwaitResponseResult,
    RemoteChatStatus,
    RemoteMessageSummary,
    RemoteNewChatResult,
    RemoteReleaseResult,
    RemoteResponseStatusResult,
    RemoteSessionRecord,
    ServerToAgentMessage
} from "./types.js";

interface RemoteOrchestratorOptions {
    serverAccessToken: string;
    dataRootDir?: string;
    defaultCommandTimeoutMs?: number;
    logger?: RemoteOrchestratorLogger;
}

interface RemoteOrchestratorLogger {
    debug(message: string, details?: Record<string, unknown>): void;
}

interface PendingCommand<T> {
    resolve(value: T): void;
    reject(error: Error): void;
    timeout: NodeJS.Timeout;
    commandType: ServerToAgentMessage["type"];
    sessionToken: string;
    startedAt: number;
    onReject?(error: Error): void | Promise<void>;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120000;
const DEFAULT_TEMPORARY_MODE_DELAY_SECONDS = 5;
const RESTART_FAILURE_DETAIL = "Remote server restarted before the response was captured.";
const now = () => new Date().toISOString();

export class RemoteOrchestrator {
    private readonly serverAccessToken: string;
    private readonly defaultCommandTimeoutMs: number;
    private readonly store: PersistentMessageStore;
    private readonly logger: RemoteOrchestratorLogger;
    private readonly connectedAgents = new Map<string, ConnectedAgentRecord>();
    private readonly sessions = new Map<string, RemoteSessionRecord>();
    private readonly userLiveChats = new Map<string, Map<number, string>>();
    private readonly mcpBindings = new Map<string, McpBindingRecord>();
    private readonly pendingCommands = new Map<string, PendingCommand<unknown>>();

    constructor(options: RemoteOrchestratorOptions) {
        this.serverAccessToken = options.serverAccessToken.trim();
        this.defaultCommandTimeoutMs = options.defaultCommandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
        this.store = new PersistentMessageStore(resolveRemoteDataRootDir(options.dataRootDir), "remote");
        this.logger = options.logger ?? {
            debug() {
                return;
            }
        };
    }

    async initialize() {
        await this.store.initialize({
            failInFlightDetail: RESTART_FAILURE_DETAIL,
            releaseAllChats: true
        });
    }

    getHealthView() {
        return {
            ok: true,
            connectedAgents: this.connectedAgents.size,
            activeMcpSessions: this.mcpBindings.size,
            activeChatSessions: this.sessions.size
        };
    }

    verifyServerAccessToken(token: string | null | undefined) {
        if (!token || token.trim() !== this.serverAccessToken) {
            throw new HttpError(401, "Invalid server access token.");
        }
    }

    resolveUserId(userToken: string) {
        const normalized = userToken.trim();
        if (!normalized) {
            throw new HttpError(400, "User token is required.");
        }

        return createHash("sha256").update(normalized).digest("hex");
    }

    ensureMcpBinding(mcpSessionId: string, userId: string) {
        const existing = this.mcpBindings.get(mcpSessionId);
        if (existing) {
            if (existing.userId !== userId) {
                throw new HttpError(403, "The MCP session is already bound to another user.");
            }

            existing.updatedAt = now();
            return existing;
        }

        const timestamp = now();
        const binding: McpBindingRecord = {
            mcpSessionId,
            userId,
            defaultChat: null,
            createdAt: timestamp,
            updatedAt: timestamp
        };
        this.mcpBindings.set(mcpSessionId, binding);
        return binding;
    }

    closeMcpBinding(mcpSessionId: string) {
        this.mcpBindings.delete(mcpSessionId);
    }

    registerAgent(hello: Extract<AgentToServerMessage, { type: "agent.hello" }>, agent: ConnectedAgentRecord) {
        this.verifyServerAccessToken(hello.serverAccessToken);
        const userId = this.resolveUserId(hello.userToken);
        const existingAgent = this.connectedAgents.get(userId);
        if (existingAgent) {
            existingAgent.close(4001, "A new agent replaced this connection.");
        }

        agent.userId = userId;
        agent.status = "ready";
        agent.updatedAt = now();
        agent.temporaryModeDelaySeconds = normalizeTemporaryModeDelaySeconds(hello.temporaryModeDelaySeconds);
        this.connectedAgents.set(userId, agent);
        this.logDebug("Registered browser agent.", {
            agentId: agent.agentId,
            userId,
            temporaryModeDelaySeconds: agent.temporaryModeDelaySeconds
        });
        return {
            agentId: agent.agentId,
            userId
        };
    }

    disconnectAgent(userId: string, agentId: string) {
        const existing = this.connectedAgents.get(userId);
        if (!existing || existing.agentId !== agentId) {
            return;
        }

        existing.status = "closed";
        existing.updatedAt = now();
        this.connectedAgents.delete(userId);
        this.logDebug("Disconnected browser agent.", {
            agentId,
            userId
        });
    }

    async newChat(
        userId: string,
        mcpSessionId: string,
        temporary = true,
        count = 1
    ): Promise<RemoteNewChatResult> {
        if (!Number.isInteger(count) || count < 1) {
            throw new HttpError(400, "count must be a positive integer.");
        }

        const chats: number[] = [];
        for (let index = 0; index < count; index += 1) {
            const chat = await this.openSingleChat(userId, mcpSessionId, temporary);
            chats.push(chat);
        }

        if (chats.length === 1) {
            return {
                chat: chats[0]
            };
        }

        return {
            chats
        };
    }

    async askAsync(
        userId: string,
        mcpSessionId: string,
        requestText: string,
        requestedChat?: number | null
    ): Promise<RemoteAskAsyncResult> {
        const session = this.resolveLiveSession(userId, mcpSessionId, requestedChat);
        if (session.state !== "ready" || session.activeMessage) {
            throw new HttpError(409, "The requested chat already has an active request.");
        }

        const message = await this.store.createMessage(userId, session.chat, requestText.trim());
        const stats = await this.store.getDurationStats();
        session.activeMessage = {
            message: message.message,
            commandId: "",
            createdAt: message.createdAt
        };
        session.state = "sending";
        session.detail = "Waiting for the browser agent to send the prompt.";
        session.updatedAt = now();

        this.logDebug("Queued async prompt.", {
            userId,
            mcpSessionId,
            chat: session.chat,
            message: message.message,
            textLength: requestText.length,
            requestText
        });

        await this.issueAskAccepted(userId, session, requestText);
        return {
            chat: session.chat,
            message: message.message,
            etaMinMs: stats.p50Ms ?? 60_000,
            etaMaxMs: stats.p90Ms ?? 300_000
        };
    }

    async awaitResponse(
        userId: string,
        mcpSessionId: string,
        requestedChat: number | null | undefined,
        message: number
    ): Promise<RemoteAwaitResponseResult> {
        if (!Number.isInteger(message) || message < 1) {
            throw new HttpError(400, "message must be a positive integer.");
        }

        const chat = this.resolveChatNumber(userId, mcpSessionId, requestedChat);
        const storedMessage = await this.store.getMessage(userId, chat, message);
        if (!storedMessage) {
            throw new HttpError(404, "The requested message does not exist.", {
                chat,
                message
            });
        }

        if (storedMessage.status === "sending" || storedMessage.status === "pending") {
            this.logDebug("await_response returned pending.", {
                userId,
                mcpSessionId,
                chat,
                message,
                status: storedMessage.status
            });
            return {
                status: "pending",
                chat,
                message,
                elapsedMs: computeElapsedMs(storedMessage)
            };
        }

        if (storedMessage.status === "failed") {
            this.logDebug("await_response returned failed.", {
                userId,
                mcpSessionId,
                chat,
                message,
                detail: storedMessage.detail || null
            });
            return {
                status: "failed",
                chat,
                message,
                detail: storedMessage.detail || "The prompt execution failed.",
                elapsedMs: computeElapsedMs(storedMessage)
            };
        }

        const readMessage = await this.store.markMessageRead(userId, chat, message);
        this.logDebug("await_response returned completed.", {
            userId,
            mcpSessionId,
            chat,
            message,
            responseLength: readMessage.responseText?.length || 0
        });
        return {
            status: "completed",
            chat,
            message,
            response: readMessage.responseText || "",
            read: readMessage.read
        };
    }

    async releaseChat(
        userId: string,
        mcpSessionId: string,
        requestedChat?: number | null,
        requestedChats?: number[] | null
    ): Promise<RemoteReleaseResult> {
        const chats = this.resolveReleaseChats(userId, mcpSessionId, requestedChat, requestedChats);
        for (const chat of chats) {
            const session = this.getLiveSession(userId, chat);
            if (session && (session.state !== "ready" || session.activeMessage)) {
                throw new HttpError(409, "One of the requested chats has an unfinished request.");
            }
        }

        for (const chat of chats) {
            const session = this.getLiveSession(userId, chat);
            if (session) {
                await this.tryReleaseSessionOnAgent(userId, session.internalSessionKey);
                this.removeLiveSession(userId, chat, session.internalSessionKey);
            }

            await this.store.ensureChat(userId, chat, {
                temporary: session?.mode === "temporary",
                released: true
            });
            await this.store.setChatReleased(userId, chat, true);
            this.clearReleasedChatDefaults(userId, chat);
        }

        this.logDebug("Released chats.", {
            userId,
            mcpSessionId,
            chats
        });

        return {
            ok: true
        };
    }

    async getResponseStatus(userId: string, mcpSessionId: string): Promise<RemoteResponseStatusResult> {
        const binding = this.ensureMcpBinding(mcpSessionId, userId);
        const chats = await this.store.listChats(userId);
        const stats = await this.store.getDurationStats();
        return {
            defaultChat: binding.defaultChat,
            averageGenerationMs: stats.averageGenerationMs,
            chats: chats.map((chat) => this.toChatStatus(userId, chat))
        };
    }

    handleAgentMessage(userId: string, message: AgentToServerMessage) {
        if (message.type === "agent.log" || message.type === "pong") {
            const agent = this.connectedAgents.get(userId);
            if (agent) {
                agent.updatedAt = now();
            }
            return;
        }

        if (message.type === "session.ready") {
            this.resolvePending(message.commandId, message);
            return;
        }

        if (message.type === "session.askAccepted") {
            void this.handleAskAccepted(message);
            return;
        }

        if (message.type === "session.askResult") {
            void this.handleAskResult(message);
            return;
        }

        if (message.type === "session.commandResult") {
            this.resolvePending(message.commandId, message);
            return;
        }

        if (message.type === "session.released") {
            this.resolvePending(message.commandId, message);
            return;
        }

        if (message.type === "session.error") {
            void this.handleSessionError(message);
        }
    }

    private async openSingleChat(userId: string, mcpSessionId: string, temporary = true) {
        const binding = this.ensureMcpBinding(mcpSessionId, userId);
        const mode: ChatMode = temporary ? "temporary" : "normal";
        const storedChat = await this.store.createChat(userId, {
            temporary
        });
        const internalSessionKey = randomUUID();
        const timestamp = now();
        const session: RemoteSessionRecord = {
            internalSessionKey,
            chat: storedChat.chat,
            userId,
            state: "starting",
            mode,
            detail: "Waiting for the browser agent to open a fresh chat tab.",
            conversationUrl: null,
            tabId: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            activeMessage: null
        };

        this.sessions.set(internalSessionKey, session);
        this.getUserLiveChatMap(userId).set(storedChat.chat, internalSessionKey);
        binding.defaultChat = storedChat.chat;
        binding.updatedAt = timestamp;
        this.logDebug("Opening live chat session.", {
            userId,
            mcpSessionId,
            chat: storedChat.chat,
            temporary
        });

        try {
            const ready = await this.issueCommand<AgentSessionReadyMessage>(userId, {
                type: "session.start",
                sessionToken: internalSessionKey,
                targetUrl: CHATGPT_HOME_URL,
                openInTemporaryMode: false
            });

            session.state = "ready";
            session.detail = ready.detail ?? "Chat session is ready.";
            session.conversationUrl = ready.conversationUrl ?? null;
            session.mode = ready.mode ?? mode;
            session.tabId = ready.tabId ?? null;
            session.updatedAt = now();

            if (temporary) {
                const agent = this.getConnectedAgent(userId);
                await sleep(agent.temporaryModeDelaySeconds * 1000);
                const temporaryResult = await this.issueCommand<AgentSessionCommandResultMessage>(userId, {
                    type: "session.setTemporary",
                    sessionToken: internalSessionKey
                });
                session.mode = temporaryResult.mode ?? "temporary";
                session.detail = temporaryResult.detail ?? "Temporary chat mode is enabled.";
                session.updatedAt = now();
                await this.store.setChatTemporary(userId, session.chat, true);
            }

            this.logDebug("Live chat session is ready.", {
                userId,
                mcpSessionId,
                chat: storedChat.chat,
                mode: session.mode,
                conversationUrl: session.conversationUrl
            });

            return storedChat.chat;
        } catch (error) {
            await this.tryReleaseSessionOnAgent(userId, internalSessionKey);
            this.removeLiveSession(userId, storedChat.chat, internalSessionKey);
            if (binding.defaultChat === storedChat.chat) {
                binding.defaultChat = null;
                binding.updatedAt = now();
            }
            await this.store.setChatReleased(userId, storedChat.chat, true);
            this.logDebug("Failed to open live chat session.", {
                userId,
                mcpSessionId,
                chat: storedChat.chat,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    private resolveChatNumber(userId: string, mcpSessionId: string, requestedChat?: number | null) {
        const binding = this.ensureMcpBinding(mcpSessionId, userId);
        const chat = requestedChat ?? binding.defaultChat;
        if (!chat) {
            throw new HttpError(409, "No chat is bound to the current MCP session.");
        }

        return chat;
    }

    private resolveLiveSession(userId: string, mcpSessionId: string, requestedChat?: number | null) {
        const chat = this.resolveChatNumber(userId, mcpSessionId, requestedChat);
        const session = this.getLiveSession(userId, chat);
        if (!session) {
            throw new HttpError(409, "The requested chat is not active.");
        }

        return session;
    }

    private resolveReleaseChats(
        userId: string,
        mcpSessionId: string,
        requestedChat?: number | null,
        requestedChats?: number[] | null
    ) {
        if (requestedChat != null && requestedChats?.length) {
            throw new HttpError(400, "Use either chat or chats, not both.");
        }

        if (requestedChats?.length) {
            const uniqueChats = [...new Set(requestedChats)];
            if (uniqueChats.some((chat) => !Number.isInteger(chat) || chat < 1)) {
                throw new HttpError(400, "chats must contain positive integers.");
            }

            return uniqueChats;
        }

        return [this.resolveChatNumber(userId, mcpSessionId, requestedChat)];
    }

    private toChatStatus(userId: string, chat: PersistedChatRecord): RemoteChatStatus {
        const liveSession = this.getLiveSession(userId, chat.chat);
        return {
            chat: chat.chat,
            state: liveSession?.state ?? (chat.released ? "released" : "ready"),
            temporary: liveSession ? liveSession.mode === "temporary" : chat.temporary,
            messages: chat.messages.map((message) => this.toMessageSummary(message))
        };
    }

    private toMessageSummary(message: PersistedMessageRecord): RemoteMessageSummary {
        return {
            message: message.message,
            status: message.status,
            read: message.read,
            createdAt: message.createdAt,
            completedAt: message.completedAt,
            elapsedMs: computeElapsedMs(message),
            generationMs: message.generationMs
        };
    }

    private getConnectedAgent(userId: string) {
        const agent = this.connectedAgents.get(userId);
        if (!agent || agent.status !== "ready") {
            throw new HttpError(503, "The browser agent for this user is offline.");
        }

        return agent;
    }

    private getUserLiveChatMap(userId: string) {
        const existing = this.userLiveChats.get(userId);
        if (existing) {
            return existing;
        }

        const created = new Map<number, string>();
        this.userLiveChats.set(userId, created);
        return created;
    }

    private getLiveSession(userId: string, chat: number) {
        const internalSessionKey = this.getUserLiveChatMap(userId).get(chat);
        if (!internalSessionKey) {
            return null;
        }

        return this.sessions.get(internalSessionKey) || null;
    }

    private async issueAskAccepted(userId: string, session: RemoteSessionRecord, requestText: string) {
        const onReject = async (error: Error) => {
            const activeMessage = session.activeMessage;
            session.state = "ready";
            session.activeMessage = null;
            session.detail = error.message;
            session.updatedAt = now();
            if (activeMessage) {
                await this.store.failMessage(userId, session.chat, activeMessage.message, error.message);
            }
        };

        const result = await this.issueCommand<AgentSessionAskAcceptedMessage>(
            userId,
            {
                type: "session.ask",
                sessionToken: session.internalSessionKey,
                request: requestText
            },
            this.defaultCommandTimeoutMs,
            onReject,
            (commandId) => {
                if (session.activeMessage) {
                    session.activeMessage.commandId = commandId;
                }
            }
        );

        await this.handleAskAccepted(result);
    }

    private async tryReleaseSessionOnAgent(userId: string, internalSessionKey: string) {
        const agent = this.connectedAgents.get(userId);
        if (!agent || agent.status !== "ready") {
            return;
        }

        try {
            await this.issueCommand<AgentSessionReleasedMessage>(
                userId,
                {
                    type: "session.release",
                    sessionToken: internalSessionKey
                },
                5000
            );
        } catch {
            return;
        }
    }

    private issueCommand<T>(
        userId: string,
        command:
            | {
                type: "session.start";
                sessionToken: string;
                targetUrl: string;
                openInTemporaryMode: boolean;
            }
            | {
                type: "session.ask";
                sessionToken: string;
                request: string;
            }
            | {
                type: "session.setTemporary";
                sessionToken: string;
            }
            | {
                type: "session.release";
                sessionToken: string;
            },
        timeoutMs = this.defaultCommandTimeoutMs,
        onReject?: PendingCommand<T>["onReject"],
        onCommandId?: (commandId: string) => void
    ) {
        const agent = this.getConnectedAgent(userId);
        const commandId = randomUUID();
        onCommandId?.(commandId);

        const payload = {
            ...command,
            commandId
        } satisfies ServerToAgentMessage;
        this.logDebug("Sending command to the browser agent.", {
            userId,
            commandId,
            commandType: payload.type,
            sessionToken: payload.sessionToken,
            timeoutMs,
            requestText: payload.type === "session.ask" ? payload.request : undefined
        });

        return new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.failPending(commandId, new HttpError(504, `Timed out while waiting for agent command ${command.type}.`));
            }, timeoutMs);

            this.pendingCommands.set(commandId, {
                resolve: resolve as PendingCommand<unknown>["resolve"],
                reject,
                timeout,
                commandType: payload.type,
                sessionToken: payload.sessionToken,
                startedAt: Date.now(),
                onReject: onReject as PendingCommand<unknown>["onReject"]
            });

            try {
                agent.send(payload);
            } catch (error) {
                this.failPending(commandId, error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private async handleAskAccepted(message: AgentSessionAskAcceptedMessage) {
        const session = this.sessions.get(message.sessionToken);
        if (!session || !session.activeMessage || session.activeMessage.commandId !== message.commandId) {
            this.resolvePending(message.commandId, message);
            return;
        }

        session.state = "waiting_response";
        session.detail = message.detail ?? "Prompt was sent.";
        session.conversationUrl = message.conversationUrl ?? session.conversationUrl;
        session.mode = message.mode ?? session.mode;
        session.updatedAt = now();
        await this.store.markMessageAccepted(session.userId, session.chat, session.activeMessage.message);
        this.logDebug("Prompt was accepted by the browser agent.", {
            userId: session.userId,
            chat: session.chat,
            message: session.activeMessage.message,
            conversationUrl: session.conversationUrl,
            sendLatencyMs: Date.now() - Date.parse(session.activeMessage.createdAt)
        });
        this.resolvePending(message.commandId, message);
    }

    private async handleAskResult(message: AgentSessionAskResultMessage) {
        const session = this.sessions.get(message.sessionToken);
        if (!session || !session.activeMessage || session.activeMessage.commandId !== message.commandId) {
            return;
        }

        const activeMessage = session.activeMessage;
        session.detail = message.detail ?? "Assistant response captured.";
        session.conversationUrl = message.conversationUrl ?? session.conversationUrl;
        session.mode = message.mode ?? session.mode;
        session.state = "ready";
        session.activeMessage = null;
        session.updatedAt = now();

        await this.store.completeMessage(session.userId, session.chat, activeMessage.message, message.responseText, message.detail);
        this.logDebug("Assistant response was stored.", {
            userId: session.userId,
            chat: session.chat,
            message: activeMessage.message,
            responseLength: message.responseText.length,
            responseText: message.responseText,
            totalElapsedMs: Date.now() - Date.parse(activeMessage.createdAt)
        });
    }

    private async handleSessionError(message: Extract<AgentToServerMessage, { type: "session.error" }>) {
        const pendingAsk = this.pendingCommands.get(message.commandId);
        const session = this.sessions.get(message.sessionToken);
        const error = new HttpError(502, message.detail);

        if (pendingAsk) {
            this.failPending(message.commandId, error);
            return;
        }

        if (!session || !session.activeMessage || session.activeMessage.commandId !== message.commandId) {
            return;
        }

        const activeMessage = session.activeMessage;
        session.detail = message.detail;
        session.state = "ready";
        session.activeMessage = null;
        session.updatedAt = now();
        await this.store.failMessage(session.userId, session.chat, activeMessage.message, message.detail);
        this.logDebug("Session failed while waiting for the assistant response.", {
            userId: session.userId,
            chat: session.chat,
            message: activeMessage.message,
            detail: message.detail,
            totalElapsedMs: Date.now() - Date.parse(activeMessage.createdAt)
        });
    }

    private logDebug(message: string, details?: Record<string, unknown>) {
        this.logger.debug(message, details);
    }

    private failPending(commandId: string, error: Error) {
        const pending = this.pendingCommands.get(commandId);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeout);
        this.pendingCommands.delete(commandId);
        this.logDebug("Command failed.", {
            commandId,
            commandType: pending.commandType,
            sessionToken: pending.sessionToken,
            durationMs: Date.now() - pending.startedAt,
            error: error.message
        });
        void pending.onReject?.(error);
        pending.reject(error);
    }

    private resolvePending(commandId: string, value: unknown) {
        const pending = this.pendingCommands.get(commandId);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeout);
        this.pendingCommands.delete(commandId);
        this.logDebug("Command completed.", {
            commandId,
            commandType: pending.commandType,
            sessionToken: pending.sessionToken,
            durationMs: Date.now() - pending.startedAt
        });
        pending.resolve(value);
    }

    private clearReleasedChatDefaults(userId: string, chat: number) {
        const timestamp = now();
        for (const binding of this.mcpBindings.values()) {
            if (binding.userId !== userId || binding.defaultChat !== chat) {
                continue;
            }

            binding.defaultChat = null;
            binding.updatedAt = timestamp;
        }
    }

    private removeLiveSession(userId: string, chat: number, internalSessionKey: string) {
        this.sessions.delete(internalSessionKey);
        const chats = this.getUserLiveChatMap(userId);
        chats.delete(chat);
        if (chats.size === 0) {
            this.userLiveChats.delete(userId);
        }
    }
}

export function createConnectedAgentRecord(
    agentId: string,
    browserName: string | undefined,
    browserVersion: string | undefined,
    send: ConnectedAgentRecord["send"],
    close: ConnectedAgentRecord["close"]
): ConnectedAgentRecord {
    const timestamp = now();
    return {
        agentId,
        userId: "",
        browserName: browserName?.trim() || null,
        browserVersion: browserVersion?.trim() || null,
        temporaryModeDelaySeconds: DEFAULT_TEMPORARY_MODE_DELAY_SECONDS,
        status: "connecting",
        connectedAt: timestamp,
        updatedAt: timestamp,
        send,
        close
    };
}

function normalizeTemporaryModeDelaySeconds(value: number | undefined) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DEFAULT_TEMPORARY_MODE_DELAY_SECONDS;
    }

    return Math.max(0, Math.round(value));
}

function resolveRemoteDataRootDir(dataRootDir?: string) {
    const baseRoot = dataRootDir || getDefaultDataRootDir();
    return join(baseRoot, "remote");
}

function getDefaultDataRootDir() {
    if (process.platform === "win32") {
        return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "chatgpt-web-bridge");
    }

    if (process.platform === "darwin") {
        return join(homedir(), "Library", "Application Support", "chatgpt-web-bridge");
    }

    return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "chatgpt-web-bridge");
}

function computeElapsedMs(message: PersistedMessageRecord) {
    const finishedAt = message.completedAt ? Date.parse(message.completedAt) : Date.now();
    return Math.max(0, finishedAt - Date.parse(message.createdAt));
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
