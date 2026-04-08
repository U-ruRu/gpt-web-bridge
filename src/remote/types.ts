import type { ChatMode } from "../bridge/types.js";

export type AgentConnectionStatus = "connecting" | "ready" | "closed";
export type RemoteSessionState = "starting" | "ready" | "sending" | "waiting_response";

export interface McpBindingRecord {
    mcpSessionId: string;
    userId: string;
    defaultChat: number | null;
    createdAt: string;
    updatedAt: string;
}

export interface RemotePendingOutcome {
    status: "completed" | "failed";
    response: string | null;
    detail: string | null;
    conversationUrl: string | null;
    mode: ChatMode;
}

export interface RemoteSessionRecord {
    internalSessionKey: string;
    chat: number;
    userId: string;
    state: RemoteSessionState;
    mode: ChatMode;
    detail: string | null;
    conversationUrl: string | null;
    tabId: number | null;
    createdAt: string;
    updatedAt: string;
    activeCommandId: string | null;
    pendingOutcome: RemotePendingOutcome | null;
}

export interface AgentHelloMessage {
    type: "agent.hello";
    serverAccessToken: string;
    userToken: string;
    agentId?: string;
    browserName?: string;
    browserVersion?: string;
}

export interface AgentReadyMessage {
    type: "agent.ready";
    agentId: string;
    userId: string;
}

export interface AgentErrorMessage {
    type: "agent.error";
    message: string;
}

export interface AgentPingMessage {
    type: "ping";
    timestamp: string;
}

export interface AgentPongMessage {
    type: "pong";
    timestamp?: string;
}

export interface AgentLogMessage {
    type: "agent.log";
    level: "debug" | "info" | "warn" | "error";
    message: string;
    context?: Record<string, unknown>;
}

export interface AgentSessionReadyMessage {
    type: "session.ready";
    commandId: string;
    sessionToken: string;
    tabId?: number;
    detail?: string | null;
    conversationUrl?: string | null;
    mode?: ChatMode;
}

export interface AgentSessionReleasedMessage {
    type: "session.released";
    commandId: string;
    sessionToken: string;
    detail?: string | null;
}

export interface AgentSessionCommandResultMessage {
    type: "session.commandResult";
    commandId: string;
    sessionToken: string;
    detail?: string | null;
    mode?: ChatMode;
}

export interface AgentSessionAskAcceptedMessage {
    type: "session.askAccepted";
    commandId: string;
    sessionToken: string;
    detail?: string | null;
    conversationUrl?: string | null;
    mode?: ChatMode;
}

export interface AgentSessionAskResultMessage {
    type: "session.askResult";
    commandId: string;
    sessionToken: string;
    detail?: string | null;
    responseText: string;
    conversationUrl?: string | null;
    mode?: ChatMode;
}

export interface AgentSessionErrorMessage {
    type: "session.error";
    commandId: string;
    sessionToken: string;
    detail: string;
}

export type AgentToServerMessage =
    | AgentHelloMessage
    | AgentPongMessage
    | AgentLogMessage
    | AgentSessionReadyMessage
    | AgentSessionReleasedMessage
    | AgentSessionCommandResultMessage
    | AgentSessionAskAcceptedMessage
    | AgentSessionAskResultMessage
    | AgentSessionErrorMessage;

export interface ServerSessionStartMessage {
    type: "session.start";
    commandId: string;
    sessionToken: string;
    targetUrl: string;
    openInTemporaryMode: boolean;
}

export interface ServerSessionAskMessage {
    type: "session.ask";
    commandId: string;
    sessionToken: string;
    request: string;
}

export interface ServerSessionSetTemporaryMessage {
    type: "session.setTemporary";
    commandId: string;
    sessionToken: string;
}

export interface ServerSessionReleaseMessage {
    type: "session.release";
    commandId: string;
    sessionToken: string;
}

export type ServerToAgentMessage =
    | AgentReadyMessage
    | AgentErrorMessage
    | AgentPingMessage
    | ServerSessionStartMessage
    | ServerSessionAskMessage
    | ServerSessionSetTemporaryMessage
    | ServerSessionReleaseMessage;

export interface ConnectedAgentRecord {
    agentId: string;
    userId: string;
    browserName: string | null;
    browserVersion: string | null;
    status: AgentConnectionStatus;
    connectedAt: string;
    updatedAt: string;
    send(message: ServerToAgentMessage): void;
    close(code?: number, reason?: string): void;
}

export interface RemoteNewChatResult {
    chat: number;
}

export interface RemoteAskAsyncResult {
    chat: number;
}

export interface RemoteAskResult {
    response: string;
}

export interface RemoteAwaitResponseResult {
    response: string;
}

export interface RemoteReleaseResult {
    ok: true;
}

export interface RemoteSessionSummary {
    chat: number;
    state: RemoteSessionState;
    temporary: boolean;
}

export interface RemoteSessionInfoResult {
    defaultChat: number | null;
    chats: RemoteSessionSummary[];
}
