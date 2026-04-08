import { createHash, randomUUID } from "node:crypto";
import { CHATGPT_HOME_URL, HttpError } from "../bridge/types.js";
import type {
    AgentSessionAskResultMessage,
    AgentSessionCommandResultMessage,
    AgentSessionReadyMessage,
    AgentSessionReleasedMessage,
    AgentToServerMessage,
    ConnectedAgentRecord,
    McpBindingRecord,
    RemoteAskResult,
    RemoteCommandResult,
    RemoteSessionRecord,
    RemoteSessionView,
    ServerToAgentMessage
} from "./types.js";

interface RemoteOrchestratorOptions {
    serverAccessToken: string;
    defaultCommandTimeoutMs?: number;
}

interface PendingCommand<T> {
    resolve(value: T): void;
    reject(error: Error): void;
    timeout: NodeJS.Timeout;
}

const now = () => new Date().toISOString();

export class RemoteOrchestrator {
    private readonly serverAccessToken: string;
    private readonly defaultCommandTimeoutMs: number;
    private readonly connectedAgents = new Map<string, ConnectedAgentRecord>();
    private readonly sessions = new Map<string, RemoteSessionRecord>();
    private readonly mcpBindings = new Map<string, McpBindingRecord>();
    private readonly pendingCommands = new Map<string, PendingCommand<unknown>>();

    constructor(options: RemoteOrchestratorOptions) {
        this.serverAccessToken = options.serverAccessToken.trim();
        this.defaultCommandTimeoutMs = options.defaultCommandTimeoutMs ?? 120000;
    }

    getHealthView() {
        return {
            ok: true,
            connectedAgents: this.connectedAgents.size,
            activeMcpSessions: this.mcpBindings.size,
            activeChatSessions: [...this.sessions.values()].filter((entry) => entry.status !== "released").length
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
            defaultSessionToken: null,
            ownedSessionTokens: new Set<string>(),
            createdAt: timestamp,
            updatedAt: timestamp
        };
        this.mcpBindings.set(mcpSessionId, binding);
        return binding;
    }

    closeMcpBinding(mcpSessionId: string) {
        const binding = this.mcpBindings.get(mcpSessionId);
        if (!binding) {
            return;
        }

        this.mcpBindings.delete(mcpSessionId);
        for (const sessionToken of binding.ownedSessionTokens) {
            const session = this.sessions.get(sessionToken);
            if (!session) {
                continue;
            }

            session.status = "released";
            session.updatedAt = now();
            void this.tryReleaseSessionOnAgent(binding.userId, sessionToken);
            this.sessions.delete(sessionToken);
        }
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

    async newChat(userId: string, mcpSessionId: string, requestedSessionToken?: string | null) {
        const binding = this.ensureMcpBinding(mcpSessionId, userId);
        const sessionToken = this.allocateSessionToken(binding, requestedSessionToken);
        const timestamp = now();
        const session: RemoteSessionRecord = {
            sessionToken,
            userId,
            ownerMcpSessionId: mcpSessionId,
            status: "starting",
            mode: "normal",
            detail: "Waiting for the browser agent to open a fresh chat tab.",
            conversationUrl: null,
            tabId: null,
            createdAt: timestamp,
            updatedAt: timestamp
        };
        this.sessions.set(sessionToken, session);
        binding.defaultSessionToken = sessionToken;
        binding.ownedSessionTokens.add(sessionToken);
        binding.updatedAt = timestamp;

        const ready = await this.issueCommand<AgentSessionReadyMessage>(userId, {
            type: "session.start",
            sessionToken,
            targetUrl: CHATGPT_HOME_URL,
            openInTemporaryMode: false
        });

        session.status = "ready";
        session.detail = ready.detail ?? "Chat session is ready.";
        session.conversationUrl = ready.conversationUrl ?? null;
        session.mode = ready.mode ?? "normal";
        session.tabId = ready.tabId ?? null;
        session.updatedAt = now();

        return this.toSessionView(session);
    }

    async ask(userId: string, mcpSessionId: string, requestText: string, requestedSessionToken?: string | null) {
        const session = this.resolveOwnedSession(userId, mcpSessionId, requestedSessionToken);
        session.status = "busy";
        session.detail = "Waiting for the browser agent to send the prompt.";
        session.updatedAt = now();

        const result = await this.issueCommand<AgentSessionAskResultMessage>(userId, {
            type: "session.ask",
            sessionToken: session.sessionToken,
            request: requestText
        });

        session.status = "ready";
        session.detail = result.detail ?? "Assistant response captured.";
        session.conversationUrl = result.conversationUrl ?? session.conversationUrl;
        session.mode = result.mode ?? session.mode;
        session.updatedAt = now();

        const response: RemoteAskResult = {
            sessionToken: session.sessionToken,
            responseText: result.responseText,
            conversationUrl: session.conversationUrl,
            detail: session.detail,
            mode: session.mode
        };
        return response;
    }

    async setTemporary(userId: string, mcpSessionId: string, requestedSessionToken?: string | null) {
        const session = this.resolveOwnedSession(userId, mcpSessionId, requestedSessionToken);
        const result = await this.issueCommand<AgentSessionCommandResultMessage>(userId, {
            type: "session.setTemporary",
            sessionToken: session.sessionToken
        });

        session.mode = result.mode ?? "temporary";
        session.detail = result.detail ?? "Temporary chat mode is enabled.";
        session.updatedAt = now();

        const response: RemoteCommandResult = {
            sessionToken: session.sessionToken,
            detail: session.detail,
            mode: session.mode
        };
        return response;
    }

    async releaseSession(userId: string, mcpSessionId: string, requestedSessionToken?: string | null) {
        const binding = this.ensureMcpBinding(mcpSessionId, userId);
        const session = this.resolveOwnedSession(userId, mcpSessionId, requestedSessionToken);
        await this.tryReleaseSessionOnAgent(userId, session.sessionToken);
        session.status = "released";
        session.detail = "Session was released.";
        session.updatedAt = now();
        binding.ownedSessionTokens.delete(session.sessionToken);
        if (binding.defaultSessionToken === session.sessionToken) {
            binding.defaultSessionToken = null;
        }
        this.sessions.delete(session.sessionToken);

        return {
            ok: true,
            sessionToken: session.sessionToken
        };
    }

    getSessionInfo(userId: string, mcpSessionId: string, requestedSessionToken?: string | null) {
        const session = this.resolveOwnedSession(userId, mcpSessionId, requestedSessionToken);
        return this.toSessionView(session);
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

        if (message.type === "session.askResult") {
            this.resolvePending(message.commandId, message);
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
            this.rejectPending(message.commandId, new HttpError(502, message.detail));
        }
    }

    private allocateSessionToken(binding: McpBindingRecord, requestedSessionToken?: string | null) {
        const requested = requestedSessionToken?.trim() || randomUUID();
        const existing = this.sessions.get(requested);
        if (existing && existing.ownerMcpSessionId !== binding.mcpSessionId) {
            throw new HttpError(409, "The requested session token is already owned by another MCP session.");
        }

        if (existing && existing.status !== "released") {
            throw new HttpError(409, "The requested session token is already active.");
        }

        return requested;
    }

    private resolveOwnedSession(userId: string, mcpSessionId: string, requestedSessionToken?: string | null) {
        const binding = this.ensureMcpBinding(mcpSessionId, userId);
        const sessionToken = requestedSessionToken?.trim() || binding.defaultSessionToken;
        if (!sessionToken) {
            throw new HttpError(409, "No chat session is bound to the current MCP session.");
        }

        if (!binding.ownedSessionTokens.has(sessionToken)) {
            throw new HttpError(403, "The requested session does not belong to this MCP session.");
        }

        const session = this.sessions.get(sessionToken);
        if (!session || session.status === "released") {
            throw new HttpError(404, "The requested chat session does not exist.");
        }

        return session;
    }

    private toSessionView(session: RemoteSessionRecord): RemoteSessionView {
        return {
            sessionToken: session.sessionToken,
            status: session.status,
            mode: session.mode,
            detail: session.detail,
            conversationUrl: session.conversationUrl,
            tabId: session.tabId,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt
        };
    }

    private getConnectedAgent(userId: string) {
        const agent = this.connectedAgents.get(userId);
        if (!agent || agent.status !== "ready") {
            throw new HttpError(503, "The browser agent for this user is offline.");
        }

        return agent;
    }

    private async tryReleaseSessionOnAgent(userId: string, sessionToken: string) {
        const agent = this.connectedAgents.get(userId);
        if (!agent || agent.status !== "ready") {
            return;
        }

        try {
            await this.issueCommand<AgentSessionReleasedMessage>(
                userId,
                {
                    type: "session.release",
                    sessionToken
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
        timeoutMs = this.defaultCommandTimeoutMs
    ) {
        const agent = this.getConnectedAgent(userId);
        const commandId = randomUUID();
        const payload = {
            ...command,
            commandId
        } satisfies ServerToAgentMessage;

        return new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingCommands.delete(commandId);
                reject(new HttpError(504, `Timed out while waiting for agent command ${command.type}.`));
            }, timeoutMs);

            this.pendingCommands.set(commandId, {
                resolve: resolve as PendingCommand<unknown>["resolve"],
                reject,
                timeout
            });

            try {
                agent.send(payload);
            } catch (error) {
                clearTimeout(timeout);
                this.pendingCommands.delete(commandId);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
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

    private rejectPending(commandId: string, error: Error) {
        const pending = this.pendingCommands.get(commandId);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeout);
        this.pendingCommands.delete(commandId);
        pending.reject(error);
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
