import type { PersistedMessageStatus } from "../message-store.js";

export const CHATGPT_HOME_URL = "https://chatgpt.com/";
export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 4545;
export const HISTORY_SIZE_LIMIT_BYTES = 100 * 1024 * 1024;

export type ChatMode = "normal" | "temporary";
export type JobStatus = "queued" | "running" | "sent" | "failed";
export type AutomationLaunchStatus = "pending" | "claimed" | "ready" | "failed";
export type AutomationCommandType = "set-temporary";
export type AutomationCommandStatus = "pending" | "running" | "completed" | "failed";

export interface SessionRecord {
    sessionId: string;
    conversationUrl: string | null;
    freshChatRequired: boolean;
    mode: ChatMode;
    createdAt: string;
    updatedAt: string;
}

export interface SessionView extends SessionRecord {
    targetUrl: string;
}

export interface JobRecord {
    id: string;
    sessionId: string;
    text: string;
    status: JobStatus;
    detail: string | null;
    conversationUrl: string | null;
    responseText: string | null;
    createdAt: string;
    updatedAt: string;
    claimedAt: string | null;
    chat: number | null;
    message: number | null;
}

export interface JobView extends JobRecord {
    targetUrl: string;
    freshChatRequired: boolean;
    mode: ChatMode;
}

export interface JobStatusPatch {
    status: JobStatus;
    detail?: string;
    conversationUrl?: string;
    responseText?: string;
}

export interface AutomationLaunchRecord {
    token: string;
    sessionId: string;
    isTemporary: boolean;
    status: AutomationLaunchStatus;
    detail: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface AutomationCommandRecord {
    token: string;
    sessionId: string;
    type: AutomationCommandType;
    status: AutomationCommandStatus;
    detail: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface PersistedSessionState {
    sessionId: string;
    conversationUrl: string | null;
    updatedAt: string;
}

export interface HistoryExchange {
    requestText: string;
    responseText: string;
}

export interface RuntimePaths {
    dataRootDir: string;
    historyDir: string;
    logsDir: string;
    sessionsDir: string;
}

export interface BridgeServerOptions {
    host: string;
    port: number;
}

export interface NewChatResult {
    ok: true;
    sessionId: string;
    isTemporary: false;
    status: AutomationLaunchStatus;
    detail: string | null;
    launchUrl: string;
}

export interface SetTemporaryResult {
    ok: true;
    sessionId: string;
    type: AutomationCommandType;
    status: AutomationCommandStatus;
    detail: string | null;
}

export interface AskResult {
    responseText: string;
    conversationUrl: string | null;
    detail: string | null;
    jobId: string;
    status: JobStatus;
    mode: ChatMode;
    sessionId: string;
}

export interface AskAsyncResult {
    chat: number;
    message: number;
    etaMinMs: number;
    etaMaxMs: number;
}

export interface AwaitResponsePendingResult {
    status: "pending";
    chat: number;
    message: number;
    elapsedMs: number;
}

export interface AwaitResponseCompletedResult {
    status: "completed";
    chat: number;
    message: number;
    response: string;
    read: boolean;
}

export interface AwaitResponseFailedResult {
    status: "failed";
    chat: number;
    message: number;
    detail: string;
    elapsedMs: number;
}

export type AwaitResponseResult =
    | AwaitResponsePendingResult
    | AwaitResponseCompletedResult
    | AwaitResponseFailedResult;

export interface MessageStatusSummary {
    message: number;
    status: PersistedMessageStatus;
    read: boolean;
    createdAt: string;
    completedAt: string | null;
    elapsedMs: number;
    generationMs: number | null;
}

export interface ChatStatusSummary {
    chat: number;
    state: "ready" | "sending" | "waiting_response";
    temporary: boolean;
    messages: MessageStatusSummary[];
}

export interface ResponseStatusResult {
    defaultChat: number;
    averageGenerationMs: number | null;
    chats: ChatStatusSummary[];
}

export class HttpError extends Error {
    readonly statusCode: number;
    readonly details?: Record<string, unknown>;

    constructor(statusCode: number, message: string, details?: Record<string, unknown>) {
        super(message);
        this.name = "HttpError";
        this.statusCode = statusCode;
        this.details = details;
    }
}
