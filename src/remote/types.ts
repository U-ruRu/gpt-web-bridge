import type { ChatMode } from "../bridge/types.js";

export type AgentConnectionStatus = "connecting" | "ready" | "closed";
export type RemoteSessionStatus = "starting" | "ready" | "busy" | "released";

export interface McpBindingRecord {
    mcpSessionId: string;
    userId: string;
    defaultSessionToken: string | null;
    ownedSessionTokens: Set<string>;
    createdAt: string;
    updatedAt: string;
}

export interface RemoteSessionRecord {
    sessionToken: string;
    userId: string;
    ownerMcpSessionId: string;
    status: RemoteSessionStatus;
    mode: ChatMode;
    detail: string | null;
    conversationUrl: string | null;
    tabId: number | null;
    createdAt: string;
    updatedAt: string;
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

export interface RemoteSessionView {
    sessionToken: string;
    status: RemoteSessionStatus;
    mode: ChatMode;
    detail: string | null;
    conversationUrl: string | null;
    tabId: number | null;
    createdAt: string;
    updatedAt: string;
}

export interface RemoteAskResult {
    sessionToken: string;
    responseText: string;
    conversationUrl: string | null;
    detail: string | null;
    mode: ChatMode;
}

export interface RemoteCommandResult {
    sessionToken: string;
    detail: string | null;
    mode: ChatMode;
}
