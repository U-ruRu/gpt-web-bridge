import { createHash, randomUUID } from "node:crypto";
import { CHATGPT_HOME_URL, HttpError } from "../bridge/types.js";
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
    RemoteAskResult,
    RemoteAwaitResponseResult,
    RemoteNewChatResult,
    RemoteReleaseResult,
    RemoteSessionInfoResult,
    RemoteSessionRecord,
    RemoteSessionSummary,
    ServerToAgentMessage
} from "./types.js";

interface RemoteOrchestratorOptions {
    serverAccessToken: string;
    defaultCommandTimeoutMs?: number;
    defaultResponseTimeoutMs?: number;
}

interface PendingCommand<T> {
    resolve(value: T): void;
    reject(error: Error): void;
    timeout: NodeJS.Timeout;
    onReject?(error: Error): void;
}

interface PendingResponseWaiter {
    resolve(value: RemoteAwaitResponseResult): void;
    reject(error: Error): void;
    timeout: NodeJS.Timeout;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 180000;
const TEMPORARY_MODE_DELAY_MS = 3000;
const now = () => new Date().toISOString();

export class RemoteOrchestrator {
    private readonly serverAccessToken: string;
    private readonly defaultCommandTimeoutMs: number;
    private readonly defaultResponseTimeoutMs: number;
    private readonly connectedAgents = new Map<string, ConnectedAgentRecord>();
    private readonly sessions = new Map<string, RemoteSessionRecord>();
    private readonly userChats = new Map<string, Map<number, string>>();
    private readonly mcpBindings = new Map<string, McpBindingRecord>();
    private readonly pendingCommands = new Map<string, PendingCommand<unknown>>();
    private readonly responseWaiters = new Map<string, PendingResponseWaiter[]>();

    constructor(options: RemoteOrchestratorOptions) {
        this.serverAccessToken = options.serverAccessToken.trim();
        this.defaultCommandTimeoutMs = options.defaultCommandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
        this.defaultResponseTimeoutMs = options.defaultResponseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
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
        this.connectedAgents.set(userId, agent);
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
    }

    async newChat(userId: string, mcpSessionId: string, temporary = true): Promise<RemoteNewChatResult> {
        const binding = this.ensureMcpBinding(mcpSessionId, userId);
        const chat = this.allocateChatNumber(userId);
        const internalSessionKey = randomUUID();
        const timestamp = now();
        const session: RemoteSessionRecord = {
            internalSessionKey,
            chat,
            userId,
            state: "starting",
            mode: "normal",
            detail: "Waiting for the browser agent to open a fresh chat tab.",
            conversationUrl: null,
            tabId: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            activeCommandId: null,
            pendingOutcome: null
        };

        this.sessions.set(internalSessionKey, session);
        this.getUserChatMap(userId).set(chat, internalSessionKey);
        binding.defaultChat = chat;
        binding.updatedAt = timestamp;

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
            session.mode = ready.mode ?? "normal";
            session.tabId = ready.tabId ?? null;
            session.updatedAt = now();

            if (temporary) {
                await sleep(TEMPORARY_MODE_DELAY_MS);
                const temporaryResult = await this.issueCommand<AgentSessionCommandResultMessage>(userId, {
                    type: "session.setTemporary",
                    sessionToken: internalSessionKey
                });
                session.mode = temporaryResult.mode ?? "temporary";
                session.detail = temporaryResult.detail ?? "Temporary chat mode is enabled.";
                session.updatedAt = now();
            }

            return {
                chat
            };
        } catch (error) {
            await this.tryReleaseSessionOnAgent(userId, internalSessionKey);
            this.removeSession(userId, chat, internalSessionKey);
            if (binding.defaultChat === chat) {
                binding.defaultChat = null;
                binding.updatedAt = now();
            }
            throw error;
        }
    }

    async ask(userId: string, mcpSessionId: string, requestText: string, requestedChat?: number | null): Promise<RemoteAskResult> {
        const result = await this.askAsync(userId, mcpSessionId, requestText, requestedChat);
        return await this.awaitResponse(userId, mcpSessionId, result.chat);
    }

    async askAsync(
        userId: string,
        mcpSessionId: string,
        requestText: string,
        requestedChat?: number | null
    ): Promise<RemoteAskAsyncResult> {
        const session = this.resolveChatSession(userId, mcpSessionId, requestedChat);
        if (session.state !== "ready" || session.pendingOutcome) {
            throw new HttpError(409, "The requested chat already has an active request.");
        }

        session.state = "sending";
        session.detail = "Waiting for the browser agent to send the prompt.";
        session.updatedAt = now();
        session.pendingOutcome = null;

        await this.issueAskAccepted(userId, session, requestText);
        return {
            chat: session.chat
        };
    }

    async awaitResponse(
        userId: string,
        mcpSessionId: string,
        requestedChat?: number | null
    ): Promise<RemoteAwaitResponseResult> {
        const session = this.resolveChatSession(userId, mcpSessionId, requestedChat);
        if (session.pendingOutcome) {
            return this.consumePendingOutcome(session);
        }

        if (session.state !== "sending" && session.state !== "waiting_response") {
            throw new HttpError(409, "The requested chat does not have a pending response.");
        }

        return await new Promise<RemoteAwaitResponseResult>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.removeResponseWaiter(session.internalSessionKey, waiter);
                reject(new HttpError(504, "Timed out while waiting for the ChatGPT response."));
            }, this.defaultResponseTimeoutMs);

            const waiter: PendingResponseWaiter = {
                resolve,
                reject,
                timeout
            };
            const queue = this.responseWaiters.get(session.internalSessionKey) || [];
            queue.push(waiter);
            this.responseWaiters.set(session.internalSessionKey, queue);
        });
    }

    async releaseChat(
        userId: string,
        mcpSessionId: string,
        requestedChat?: number | null
    ): Promise<RemoteReleaseResult> {
        const session = this.resolveChatSession(userId, mcpSessionId, requestedChat);
        if (session.state !== "ready" || session.pendingOutcome) {
            throw new HttpError(409, "The requested chat has an unfinished request.");
        }

        await this.tryReleaseSessionOnAgent(userId, session.internalSessionKey);
        this.removeSession(userId, session.chat, session.internalSessionKey);
        this.clearReleasedChatDefaults(userId, session.chat);

        return {
            ok: true
        };
    }

    getSessionInfo(userId: string, mcpSessionId: string): RemoteSessionInfoResult {
        const binding = this.ensureMcpBinding(mcpSessionId, userId);
        const chats = [...this.getUserChatMap(userId).entries()]
            .sort((left, right) => left[0] - right[0])
            .map(([, internalSessionKey]) => this.sessions.get(internalSessionKey))
            .filter((session): session is RemoteSessionRecord => Boolean(session))
            .map((session) => this.toSessionSummary(session));

        return {
            defaultChat: binding.defaultChat,
            chats
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
            this.handleAskAccepted(message);
            return;
        }

        if (message.type === "session.askResult") {
            this.handleAskResult(message);
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
            this.handleSessionError(message);
        }
    }

    private allocateChatNumber(userId: string) {
        const chats = this.getUserChatMap(userId);
        let nextChat = 1;
        while (chats.has(nextChat)) {
            nextChat += 1;
        }

        return nextChat;
    }

    private resolveChatSession(userId: string, mcpSessionId: string, requestedChat?: number | null) {
        const binding = this.ensureMcpBinding(mcpSessionId, userId);
        const chat = requestedChat ?? binding.defaultChat;
        if (!chat) {
            throw new HttpError(409, "No chat is bound to the current MCP session.");
        }

        const internalSessionKey = this.getUserChatMap(userId).get(chat);
        if (!internalSessionKey) {
            if (binding.defaultChat === chat) {
                binding.defaultChat = null;
                binding.updatedAt = now();
            }
            throw new HttpError(404, "The requested chat does not exist.");
        }

        const session = this.sessions.get(internalSessionKey);
        if (!session) {
            throw new HttpError(404, "The requested chat does not exist.");
        }

        return session;
    }

    private toSessionSummary(session: RemoteSessionRecord): RemoteSessionSummary {
        return {
            chat: session.chat,
            state: session.state,
            temporary: session.mode === "temporary"
        };
    }

    private getConnectedAgent(userId: string) {
        const agent = this.connectedAgents.get(userId);
        if (!agent || agent.status !== "ready") {
            throw new HttpError(503, "The browser agent for this user is offline.");
        }

        return agent;
    }

    private getUserChatMap(userId: string) {
        const existing = this.userChats.get(userId);
        if (existing) {
            return existing;
        }

        const created = new Map<number, string>();
        this.userChats.set(userId, created);
        return created;
    }

    private async issueAskAccepted(userId: string, session: RemoteSessionRecord, requestText: string) {
        const onReject = (error: Error) => {
            session.state = "ready";
            session.activeCommandId = null;
            session.detail = error.message;
            session.updatedAt = now();
            this.rejectResponseWaiters(session.internalSessionKey, error);
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
                session.activeCommandId = commandId;
            }
        );

        session.state = "waiting_response";
        session.detail = result.detail ?? "Prompt was sent.";
        session.conversationUrl = result.conversationUrl ?? session.conversationUrl;
        session.mode = result.mode ?? session.mode;
        session.updatedAt = now();
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

        return new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.failPending(commandId, new HttpError(504, `Timed out while waiting for agent command ${command.type}.`));
            }, timeoutMs);

            this.pendingCommands.set(commandId, {
                resolve: resolve as PendingCommand<unknown>["resolve"],
                reject,
                timeout,
                onReject: onReject as PendingCommand<unknown>["onReject"]
            });

            try {
                agent.send(payload);
            } catch (error) {
                this.failPending(commandId, error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private handleAskAccepted(message: AgentSessionAskAcceptedMessage) {
        const session = this.sessions.get(message.sessionToken);
        if (session && session.activeCommandId === message.commandId) {
            session.state = "waiting_response";
            session.detail = message.detail ?? "Prompt was sent.";
            session.conversationUrl = message.conversationUrl ?? session.conversationUrl;
            session.mode = message.mode ?? session.mode;
            session.updatedAt = now();
        }
        this.resolvePending(message.commandId, message);
    }

    private handleAskResult(message: AgentSessionAskResultMessage) {
        const session = this.sessions.get(message.sessionToken);
        if (!session || session.activeCommandId !== message.commandId) {
            return;
        }

        session.pendingOutcome = {
            status: "completed",
            response: message.responseText,
            detail: message.detail ?? "Assistant response captured.",
            conversationUrl: message.conversationUrl ?? session.conversationUrl,
            mode: message.mode ?? session.mode
        };
        session.detail = session.pendingOutcome.detail;
        session.conversationUrl = session.pendingOutcome.conversationUrl;
        session.mode = session.pendingOutcome.mode;
        session.state = "waiting_response";
        session.activeCommandId = null;
        session.updatedAt = now();
        this.flushPendingOutcomeToWaiters(session);
    }

    private handleSessionError(message: Extract<AgentToServerMessage, { type: "session.error" }>) {
        const pendingAsk = this.pendingCommands.get(message.commandId);
        const session = this.sessions.get(message.sessionToken);
        const error = new HttpError(502, message.detail);

        if (pendingAsk) {
            this.failPending(message.commandId, error);
            return;
        }

        if (!session || session.activeCommandId !== message.commandId) {
            return;
        }

        session.pendingOutcome = {
            status: "failed",
            response: null,
            detail: message.detail,
            conversationUrl: session.conversationUrl,
            mode: session.mode
        };
        session.detail = message.detail;
        session.state = "waiting_response";
        session.activeCommandId = null;
        session.updatedAt = now();
        this.flushPendingOutcomeToWaiters(session);
    }

    private flushPendingOutcomeToWaiters(session: RemoteSessionRecord) {
        const waiters = this.responseWaiters.get(session.internalSessionKey);
        if (!waiters?.length || !session.pendingOutcome) {
            return;
        }

        this.responseWaiters.delete(session.internalSessionKey);
        const outcome = session.pendingOutcome;
        session.pendingOutcome = null;
        session.state = "ready";
        session.updatedAt = now();

        if (outcome.status === "failed") {
            const error = new HttpError(502, outcome.detail || "The prompt execution failed.");
            for (const waiter of waiters) {
                clearTimeout(waiter.timeout);
                waiter.reject(error);
            }
            return;
        }

        const result: RemoteAwaitResponseResult = {
            response: outcome.response || ""
        };
        for (const waiter of waiters) {
            clearTimeout(waiter.timeout);
            waiter.resolve(result);
        }
    }

    private consumePendingOutcome(session: RemoteSessionRecord): RemoteAwaitResponseResult {
        const outcome = session.pendingOutcome;
        if (!outcome) {
            throw new HttpError(409, "The requested chat does not have a pending response.");
        }

        session.pendingOutcome = null;
        session.state = "ready";
        session.updatedAt = now();

        if (outcome.status === "failed") {
            throw new HttpError(502, outcome.detail || "The prompt execution failed.");
        }

        return {
            response: outcome.response || ""
        };
    }

    private failPending(commandId: string, error: Error) {
        const pending = this.pendingCommands.get(commandId);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeout);
        this.pendingCommands.delete(commandId);
        pending.onReject?.(error);
        pending.reject(error);
    }

    private resolvePending(commandId: string, value: unknown) {
        const pending = this.pendingCommands.get(commandId);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeout);
        this.pendingCommands.delete(commandId);
        pending.resolve(value);
    }

    private rejectResponseWaiters(internalSessionKey: string, error: Error) {
        const waiters = this.responseWaiters.get(internalSessionKey);
        if (!waiters?.length) {
            return;
        }

        this.responseWaiters.delete(internalSessionKey);
        for (const waiter of waiters) {
            clearTimeout(waiter.timeout);
            waiter.reject(error);
        }
    }

    private removeResponseWaiter(internalSessionKey: string, targetWaiter: PendingResponseWaiter) {
        const waiters = this.responseWaiters.get(internalSessionKey);
        if (!waiters?.length) {
            return;
        }

        const nextWaiters = waiters.filter((waiter) => waiter !== targetWaiter);
        if (nextWaiters.length === 0) {
            this.responseWaiters.delete(internalSessionKey);
            return;
        }

        this.responseWaiters.set(internalSessionKey, nextWaiters);
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

    private removeSession(userId: string, chat: number, internalSessionKey: string) {
        this.sessions.delete(internalSessionKey);
        this.responseWaiters.delete(internalSessionKey);

        const chats = this.getUserChatMap(userId);
        chats.delete(chat);
        if (chats.size === 0) {
            this.userChats.delete(userId);
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
        status: "connecting",
        connectedAt: timestamp,
        updatedAt: timestamp,
        send,
        close
    };
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
