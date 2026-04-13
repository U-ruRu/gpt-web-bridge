import { randomUUID } from "node:crypto";
import { mkdir, appendFile, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
    AskResult,
    AskAsyncResult,
    AutomationCommandRecord,
    AutomationCommandStatus,
    AutomationCommandType,
    AutomationLaunchRecord,
    AutomationLaunchStatus,
    AwaitResponseResult,
    CHATGPT_HOME_URL,
    ChatStatusSummary,
    HISTORY_SIZE_LIMIT_BYTES,
    HistoryExchange,
    HttpError,
    JobRecord,
    JobStatusPatch,
    JobView,
    MessageStatusSummary,
    NewChatResult,
    PersistedSessionState,
    ResponseStatusResult,
    RuntimePaths,
    SessionRecord,
    SessionView,
    SetTemporaryResult
} from "./types.js";
import { PersistentMessageStore, type PersistedMessageRecord } from "../message-store.js";

const DEFAULT_JOB_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_LAUNCH_WAIT_TIMEOUT_MS = 30000;
const SESSION_LOG_FILE_SUFFIX = "-runtime.log";
const BRIDGE_CHAT_NUMBER = 1;
const DEFAULT_ETA_MIN_MS = 120000;
const DEFAULT_ETA_MAX_MS = 300000;

const now = () => new Date().toISOString();
type LogLevel = "debug" | "info" | "warn" | "error";

interface RuntimeLogger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

interface RuntimeOptions {
    sessionId: string;
    dataRootDir?: string;
    logger?: RuntimeLogger;
}

interface PreparedLaunch {
    launch: AutomationLaunchRecord;
    launchUrl: string;
}

const defaultLogger: RuntimeLogger = {
    debug(message, ...args) {
        console.error(message, ...args);
    },
    info(message, ...args) {
        console.error(message, ...args);
    },
    warn(message, ...args) {
        console.error(message, ...args);
    },
    error(message, ...args) {
        console.error(message, ...args);
    }
};

export class ChatGptWebRuntime {
    private readonly sessionIdValue: string;
    private readonly paths: RuntimePaths;
    private readonly logger: RuntimeLogger;
    private readonly messageStore: PersistentMessageStore;
    private readonly jobs = new Map<string, JobRecord>();
    private readonly automationLaunches = new Map<string, AutomationLaunchRecord>();
    private readonly automationCommands = new Map<string, AutomationCommandRecord>();
    private lastAutomationLaunchToken: string | null = null;
    private lastAutomationCommandToken: string | null = null;
    private readonly pendingHistory = new Array<HistoryExchange>();
    private readonly session: SessionRecord;

    constructor(options: RuntimeOptions) {
        const sessionId = normalizeSessionId(options.sessionId);
        this.sessionIdValue = sessionId;
        this.paths = resolveRuntimePaths(options.dataRootDir);
        this.logger = options.logger ?? defaultLogger;
        this.messageStore = new PersistentMessageStore(this.paths.dataRootDir, "bridge");
        const createdAt = now();
        this.session = {
            sessionId,
            conversationUrl: null,
            freshChatRequired: true,
            mode: "normal",
            createdAt,
            updatedAt: createdAt
        };
    }

    get sessionId() {
        return this.sessionIdValue;
    }

    get dataPaths() {
        return { ...this.paths };
    }

    async initialize() {
        await mkdir(this.paths.dataRootDir, { recursive: true });
        await mkdir(this.paths.sessionsDir, { recursive: true });
        await mkdir(this.paths.historyDir, { recursive: true });
        await mkdir(this.paths.logsDir, { recursive: true });
        await this.messageStore.initialize({
            failInFlightDetail: "The local bridge restarted before the response was captured."
        });
        await this.messageStore.ensureChat(this.sessionIdValue, BRIDGE_CHAT_NUMBER, {
            temporary: this.session.mode === "temporary"
        });
        await this.writeLog("info", "runtime", "Runtime initialized.", {
            sessionId: this.sessionIdValue,
            dataRootDir: this.paths.dataRootDir
        });

        const persisted = await this.readPersistedSessionState();
        if (!persisted?.conversationUrl) {
            await this.writeLog("info", "runtime", "No persisted conversation was found for the session.", {
                sessionId: this.sessionIdValue
            });
            return;
        }

        this.session.conversationUrl = normalizeConversationUrl(persisted.conversationUrl);
        this.session.freshChatRequired = false;
        this.session.mode = "normal";
        this.session.updatedAt = persisted.updatedAt || this.session.updatedAt;
        this.logger.info("[runtime] Restored conversation URL for session.", this.sessionIdValue, this.session.conversationUrl);
        await this.writeLog("info", "runtime", "Restored persisted conversation URL.", {
            sessionId: this.sessionIdValue,
            conversationUrl: this.session.conversationUrl
        });
    }

    hasRestorableConversation() {
        return Boolean(this.session.conversationUrl && extractChatId(this.session.conversationUrl));
    }

    getRestorableConversationUrl() {
        return this.session.conversationUrl;
    }

    getSessionView(): SessionView {
        return toSessionView(this.session);
    }

    getDiagnosticsView() {
        return {
            session: this.getSessionView(),
            pendingAutomationLaunch: this.getPendingAutomationLaunch(),
            pendingAutomationCommand: this.getPendingAutomationCommand(),
            jobs: [...this.jobs.values()]
                .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
                .map((job) => toJobView(job, this.session)),
            paths: {
                ...this.paths,
                sessionLogPath: this.getSessionLogPath()
            }
        };
    }

    async newChat(
        bridgePort: number,
        openExternalUrl: (url: string) => Promise<void>,
        waitTimeoutMs = DEFAULT_LAUNCH_WAIT_TIMEOUT_MS
    ): Promise<NewChatResult> {
        const prepared = await this.prepareNewChatLaunch(bridgePort);
        await this.writeLog("info", "runtime", "Opening a fresh chat launch URL.", {
            sessionId: this.sessionIdValue,
            bridgePort,
            launchToken: prepared.launch.token,
            launchUrl: prepared.launchUrl
        });
        await openExternalUrl(prepared.launchUrl);
        await this.writeLog("info", "runtime", "Browser launch command returned control to the bridge runtime.", {
            sessionId: this.sessionIdValue,
            launchToken: prepared.launch.token,
            waitingFor: "automation-launch-ready"
        });
        const launch = await this.waitForAutomationLaunch(prepared.launch.token, waitTimeoutMs);

        return {
            ok: true,
            sessionId: this.sessionIdValue,
            isTemporary: false,
            status: launch.status,
            detail: launch.detail,
            launchUrl: prepared.launchUrl
        };
    }

    async restoreConversationLaunch(
        bridgePort: number,
        openExternalUrl: (url: string) => Promise<void>,
        waitTimeoutMs = DEFAULT_LAUNCH_WAIT_TIMEOUT_MS
    ) {
        const prepared = await this.prepareRestoreLaunch(bridgePort);
        if (!prepared) {
            return null;
        }

        await openExternalUrl(prepared.launchUrl);
        await this.writeLog("info", "runtime", "Browser restore launch command returned control to the bridge runtime.", {
            sessionId: this.sessionIdValue,
            launchToken: prepared.launch.token,
            waitingFor: "automation-launch-ready",
            launchUrl: prepared.launchUrl
        });
        return await this.waitForAutomationLaunch(prepared.launch.token, waitTimeoutMs);
    }

    async setTemporary(waitTimeoutMs = DEFAULT_LAUNCH_WAIT_TIMEOUT_MS): Promise<SetTemporaryResult> {
        const command = this.prepareAutomationCommand("set-temporary");
        await this.writeLog("info", "runtime", "Queued automation command.", {
            sessionId: this.sessionIdValue,
            token: command.token,
            type: command.type
        });
        const resolvedCommand = await this.waitForAutomationCommand(command.token, waitTimeoutMs);
        return {
            ok: true,
            sessionId: this.sessionIdValue,
            type: resolvedCommand.type,
            status: resolvedCommand.status,
            detail: resolvedCommand.detail
        };
    }

    async ask(request: string, waitTimeoutMs = DEFAULT_JOB_WAIT_TIMEOUT_MS): Promise<AskResult> {
        const { job, message } = await this.createPromptJob(request);
        await this.writeLog("info", "runtime", "Queued ask request.", {
            sessionId: this.sessionIdValue,
            jobId: job.id,
            message: message.message,
            textLength: request.length,
            waitTimeoutMs
        });
        const resolvedJob = await this.waitForJobResolution(job.id, waitTimeoutMs);
        const resolvedMessage = await this.messageStore.getMessage(this.sessionIdValue, BRIDGE_CHAT_NUMBER, message.message);
        return {
            responseText: resolvedMessage?.responseText || resolvedJob.responseText || "",
            conversationUrl: resolvedJob.conversationUrl,
            detail: resolvedMessage?.detail || resolvedJob.detail,
            jobId: resolvedJob.id,
            status: resolvedJob.status,
            mode: resolvedJob.mode,
            sessionId: this.sessionIdValue
        };
    }

    async askAsync(request: string, requestedChat?: number | null): Promise<AskAsyncResult> {
        this.assertSupportedChat(requestedChat);
        const { message } = await this.createPromptJob(request);
        const { etaMinMs, etaMaxMs } = await this.getEtaRange();
        return {
            chat: BRIDGE_CHAT_NUMBER,
            message: message.message,
            etaMinMs,
            etaMaxMs
        };
    }

    async awaitResponse(messageNumber: number, requestedChat?: number | null): Promise<AwaitResponseResult> {
        this.assertSupportedChat(requestedChat);
        const message = await this.messageStore.getMessage(this.sessionIdValue, BRIDGE_CHAT_NUMBER, messageNumber);
        if (!message) {
            throw new HttpError(404, "The requested message does not exist.", {
                chat: BRIDGE_CHAT_NUMBER,
                message: messageNumber
            });
        }

        if (message.status === "sending" || message.status === "pending") {
            return {
                status: "pending",
                chat: BRIDGE_CHAT_NUMBER,
                message: messageNumber,
                elapsedMs: computeElapsedMs(message)
            };
        }

        if (message.status === "failed") {
            return {
                status: "failed",
                chat: BRIDGE_CHAT_NUMBER,
                message: messageNumber,
                detail: message.detail || "The prompt execution failed.",
                elapsedMs: computeElapsedMs(message)
            };
        }

        const readMessage = await this.messageStore.markMessageRead(this.sessionIdValue, BRIDGE_CHAT_NUMBER, messageNumber);
        return {
            status: "completed",
            chat: BRIDGE_CHAT_NUMBER,
            message: messageNumber,
            response: readMessage.responseText || "",
            read: readMessage.read
        };
    }

    async getResponseStatus(): Promise<ResponseStatusResult> {
        const chat = await this.messageStore.ensureChat(this.sessionIdValue, BRIDGE_CHAT_NUMBER, {
            temporary: this.session.mode === "temporary"
        });
        const stats = await this.messageStore.getDurationStats(this.sessionIdValue);
        return {
            defaultChat: BRIDGE_CHAT_NUMBER,
            averageGenerationMs: stats.averageGenerationMs,
            chats: [
                {
                    chat: BRIDGE_CHAT_NUMBER,
                    state: this.getCurrentChatState(chat.messages),
                    temporary: this.session.mode === "temporary",
                    messages: chat.messages.map((message) => toMessageStatusSummary(message))
                }
            ]
        };
    }

    async prepareNewChatLaunch(bridgePort: number): Promise<PreparedLaunch> {
        this.resetForFreshChat();
        const launch = this.createAutomationLaunch(false);
        const launchUrl = buildChatLaunchUrl(CHATGPT_HOME_URL, launch.token, bridgePort, this.sessionIdValue, false);
        await this.persistSessionState();
        await this.writeLog("debug", "runtime", "Prepared fresh chat launch.", {
            sessionId: this.sessionIdValue,
            bridgePort,
            launchToken: launch.token
        });
        return {
            launch,
            launchUrl
        };
    }

    async prepareFreshChatLaunch(): Promise<AutomationLaunchRecord> {
        this.resetForFreshChat();
        const launch = this.createAutomationLaunch(false);
        await this.persistSessionState();
        await this.writeLog("debug", "runtime", "Prepared a remote fresh chat launch.", {
            sessionId: this.sessionIdValue,
            launchToken: launch.token
        });
        return { ...launch };
    }

    async prepareRestoreLaunch(bridgePort: number): Promise<PreparedLaunch | null> {
        const conversationUrl = this.session.conversationUrl;
        if (!conversationUrl) {
            return null;
        }

        const launch = this.createAutomationLaunch(false);
        const launchUrl = buildChatLaunchUrl(conversationUrl, launch.token, bridgePort, this.sessionIdValue, false);
        await this.writeLog("debug", "runtime", "Prepared restore launch.", {
            sessionId: this.sessionIdValue,
            bridgePort,
            launchToken: launch.token,
            conversationUrl
        });
        return {
            launch,
            launchUrl
        };
    }

    getPendingAutomationLaunch() {
        if (this.lastAutomationLaunchToken) {
            const lastLaunch = this.automationLaunches.get(this.lastAutomationLaunchToken);
            if (lastLaunch && (lastLaunch.status === "pending" || lastLaunch.status === "claimed")) {
                return { ...lastLaunch };
            }
        }

        const launch = [...this.automationLaunches.values()]
            .filter((entry) => entry.status === "pending" || entry.status === "claimed")
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

        return launch ? { ...launch } : null;
    }

    async updateAutomationLaunch(token: string, status: AutomationLaunchStatus, detail?: string) {
        const launch = this.getAutomationLaunch(token);
        launch.status = status;
        launch.updatedAt = now();
        launch.detail = detail?.trim() || launch.detail;
        await this.writeLog(status === "failed" ? "error" : "info", "runtime", "Automation launch status updated.", {
            sessionId: this.sessionIdValue,
            token,
            status,
            detail: launch.detail,
            isTemporary: launch.isTemporary
        });
        return { ...launch };
    }

    getPendingAutomationCommand() {
        if (this.lastAutomationCommandToken) {
            const lastCommand = this.automationCommands.get(this.lastAutomationCommandToken);
            if (lastCommand && (lastCommand.status === "pending" || lastCommand.status === "running")) {
                return { ...lastCommand };
            }
        }

        const command = [...this.automationCommands.values()]
            .filter((entry) => entry.status === "pending" || entry.status === "running")
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

        return command ? { ...command } : null;
    }

    async updateAutomationCommand(
        token: string,
        status: AutomationCommandStatus,
        detail?: string
    ) {
        const command = this.getAutomationCommand(token);
        command.status = status;
        command.updatedAt = now();
        command.detail = detail?.trim() || command.detail;

        if (command.type === "set-temporary" && status === "completed") {
            this.session.mode = "temporary";
            this.session.updatedAt = command.updatedAt;
            await this.messageStore.setChatTemporary(this.sessionIdValue, BRIDGE_CHAT_NUMBER, true);
            await this.persistSessionState();
        }

        await this.writeLog(status === "failed" ? "error" : "info", "runtime", "Automation command status updated.", {
            sessionId: this.sessionIdValue,
            token,
            type: command.type,
            status,
            detail: command.detail
        });

        return { ...command };
    }

    queueJob(text: string): JobView {
        const normalizedText = normalizeText(text);
        const createdAt = now();
        const job: JobRecord = {
            id: randomUUID(),
            sessionId: this.sessionIdValue,
            text: normalizedText,
            status: "queued",
            detail: null,
            conversationUrl: this.session.conversationUrl,
            responseText: null,
            createdAt,
            updatedAt: createdAt,
            claimedAt: null,
            chat: null,
            message: null
        };

        this.jobs.set(job.id, job);
        void this.writeLog("debug", "runtime", "Job queued.", {
            sessionId: this.sessionIdValue,
            jobId: job.id,
            textLength: normalizedText.length,
            conversationUrl: this.session.conversationUrl
        });
        return toJobView(job, this.session);
    }

    private async createPromptJob(text: string) {
        const normalizedText = normalizeText(text);
        const chat = await this.messageStore.ensureChat(this.sessionIdValue, BRIDGE_CHAT_NUMBER, {
            temporary: this.session.mode === "temporary"
        });
        const activeMessage = chat.messages.find((message) => message.status === "sending" || message.status === "pending");
        if (activeMessage) {
            throw new HttpError(409, "The current chat already has an active request.", {
                chat: BRIDGE_CHAT_NUMBER,
                message: activeMessage.message
            });
        }

        const message = await this.messageStore.createMessage(this.sessionIdValue, BRIDGE_CHAT_NUMBER, normalizedText);
        const createdAt = now();
        const job: JobRecord = {
            id: randomUUID(),
            sessionId: this.sessionIdValue,
            text: normalizedText,
            status: "queued",
            detail: null,
            conversationUrl: this.session.conversationUrl,
            responseText: null,
            createdAt,
            updatedAt: createdAt,
            claimedAt: null,
            chat: BRIDGE_CHAT_NUMBER,
            message: message.message
        };

        this.jobs.set(job.id, job);
        void this.writeLog("debug", "runtime", "Prompt job queued.", {
            sessionId: this.sessionIdValue,
            jobId: job.id,
            message: message.message,
            textLength: normalizedText.length,
            conversationUrl: this.session.conversationUrl
        });
        return {
            job: toJobView(job, this.session),
            message
        };
    }

    claimNextJob(sessionId: string): JobView | null {
        this.assertSessionId(sessionId);
        const job = [...this.jobs.values()]
            .filter((entry) => entry.status === "queued")
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

        if (job) {
            void this.writeLog("debug", "runtime", "Queued job claimed by extension.", {
                sessionId: this.sessionIdValue,
                jobId: job.id
            });
        }
        return job ? toJobView(job, this.session) : null;
    }

    getJob(jobId: string): JobView {
        const job = this.jobs.get(jobId);
        if (!job) {
            throw new HttpError(404, "Job not found.", { jobId });
        }

        return toJobView(job, this.session);
    }

    async updateJobStatus(jobId: string, patch: JobStatusPatch): Promise<JobView> {
        const job = this.jobs.get(jobId);
        if (!job) {
            throw new HttpError(404, "Job not found.", { jobId });
        }

        job.status = patch.status;
        job.updatedAt = now();
        job.detail = patch.detail?.trim() || job.detail;

        if (patch.responseText !== undefined) {
            job.responseText = normalizeResponseText(patch.responseText);
        }

        if (patch.status === "running") {
            job.claimedAt = job.claimedAt ?? job.updatedAt;
            job.detail = patch.detail?.trim() || "Automation started processing the job.";
            if (job.message != null) {
                await this.messageStore.markMessageAccepted(this.sessionIdValue, BRIDGE_CHAT_NUMBER, job.message);
            }
        }

        if (patch.conversationUrl) {
            const normalizedConversationUrl = normalizeConversationUrl(patch.conversationUrl);
            this.session.conversationUrl = normalizedConversationUrl;
            this.session.freshChatRequired = false;
            this.session.updatedAt = job.updatedAt;
            job.conversationUrl = normalizedConversationUrl;
        }

        if (patch.status === "failed" && !job.detail) {
            job.detail = "Unknown automation error.";
        }

        if (patch.status === "sent") {
            this.session.updatedAt = job.updatedAt;
            if (this.session.conversationUrl) {
                this.session.freshChatRequired = false;
            }

            if (job.responseText) {
                await this.recordSuccessfulExchange(job.text, job.responseText, job.conversationUrl ?? this.session.conversationUrl);
            }

            if (job.message != null) {
                await this.messageStore.completeMessage(
                    this.sessionIdValue,
                    BRIDGE_CHAT_NUMBER,
                    job.message,
                    job.responseText || "",
                    job.detail
                );
            }

            await this.persistSessionState();
        }

        if (patch.status === "failed" && job.message != null) {
            await this.messageStore.failMessage(
                this.sessionIdValue,
                BRIDGE_CHAT_NUMBER,
                job.message,
                job.detail || "Unknown automation error."
            );
        }

        await this.writeLog(patch.status === "failed" ? "error" : "info", "runtime", "Job status updated.", {
            sessionId: this.sessionIdValue,
            jobId,
            status: job.status,
            detail: job.detail,
            conversationUrl: job.conversationUrl,
            hasResponseText: Boolean(job.responseText)
        });

        return toJobView(job, this.session);
    }

    async resetSession() {
        const runningJob = [...this.jobs.values()].find((job) => job.status === "running");
        if (runningJob) {
            throw new HttpError(409, "Cannot reset a session while a job is running.", {
                jobId: runningJob.id
            });
        }

        this.resetForFreshChat();
        await this.persistSessionState();
        await this.writeLog("info", "runtime", "Session was reset to a fresh chat state.", {
            sessionId: this.sessionIdValue
        });
        return toSessionView(this.session);
    }

    async waitForJobResolution(jobId: string, waitTimeoutMs: number): Promise<JobView> {
        const deadline = Date.now() + waitTimeoutMs;
        let lastStatusSignature = "";
        let nextProgressLogAt = Date.now();
        while (Date.now() < deadline) {
            const job = this.getJob(jobId);
            const statusSignature = `${job.status}|${job.detail || ""}|${job.conversationUrl || ""}|${job.responseText ? "response" : "no-response"}`;
            if (statusSignature !== lastStatusSignature || Date.now() >= nextProgressLogAt) {
                lastStatusSignature = statusSignature;
                nextProgressLogAt = Date.now() + 5000;
                await this.writeLog("debug", "runtime", "Waiting for job resolution.", {
                    sessionId: this.sessionIdValue,
                    jobId,
                    status: job.status,
                    detail: job.detail,
                    conversationUrl: job.conversationUrl,
                    hasResponseText: Boolean(job.responseText)
                });
            }

            if (job.status === "sent" || job.status === "failed") {
                return job;
            }

            await sleep(500);
        }

        await this.writeLog("error", "runtime", "Timed out while waiting for job resolution.", {
            sessionId: this.sessionIdValue,
            jobId,
            waitTimeoutMs,
            finalState: this.getJob(jobId)
        });
        throw new HttpError(504, "Timed out while waiting for the ChatGPT response.", {
            jobId,
            waitTimeoutMs
        });
    }

    async waitForAutomationLaunch(token: string, waitTimeoutMs: number): Promise<AutomationLaunchRecord> {
        const deadline = Date.now() + waitTimeoutMs;
        let lastStatusSignature = "";
        let nextProgressLogAt = Date.now();
        while (Date.now() < deadline) {
            const launch = this.getAutomationLaunch(token);
            const statusSignature = `${launch.status}|${launch.detail || ""}`;
            if (statusSignature !== lastStatusSignature || Date.now() >= nextProgressLogAt) {
                lastStatusSignature = statusSignature;
                nextProgressLogAt = Date.now() + 5000;
                await this.writeLog("debug", "runtime", "Waiting for automation launch readiness.", {
                    sessionId: this.sessionIdValue,
                    token,
                    status: launch.status,
                    detail: launch.detail,
                    isTemporary: launch.isTemporary
                });
            }

            if (launch.status === "ready") {
                return { ...launch };
            }

            if (launch.status === "failed") {
                throw new HttpError(502, launch.detail || "Automation launch failed.", {
                    token
                });
            }

            await sleep(500);
        }

        await this.writeLog("error", "runtime", "Timed out while waiting for automation launch readiness.", {
            sessionId: this.sessionIdValue,
            token,
            waitTimeoutMs,
            finalState: this.getAutomationLaunch(token)
        });
        throw new HttpError(504, "Timed out while waiting for the new chat tab to become ready.", {
            token,
            waitTimeoutMs
        });
    }

    async waitForAutomationCommand(token: string, waitTimeoutMs: number): Promise<AutomationCommandRecord> {
        const deadline = Date.now() + waitTimeoutMs;
        let lastStatusSignature = "";
        let nextProgressLogAt = Date.now();
        while (Date.now() < deadline) {
            const command = this.getAutomationCommand(token);
            const statusSignature = `${command.status}|${command.detail || ""}`;
            if (statusSignature !== lastStatusSignature || Date.now() >= nextProgressLogAt) {
                lastStatusSignature = statusSignature;
                nextProgressLogAt = Date.now() + 5000;
                await this.writeLog("debug", "runtime", "Waiting for automation command completion.", {
                    sessionId: this.sessionIdValue,
                    token,
                    type: command.type,
                    status: command.status,
                    detail: command.detail
                });
            }

            if (command.status === "completed") {
                return { ...command };
            }

            if (command.status === "failed") {
                throw new HttpError(502, command.detail || "Automation command failed.", {
                    token,
                    type: command.type
                });
            }

            await sleep(500);
        }

        await this.writeLog("error", "runtime", "Timed out while waiting for automation command completion.", {
            sessionId: this.sessionIdValue,
            token,
            waitTimeoutMs,
            finalState: this.getAutomationCommand(token)
        });
        throw new HttpError(504, "Timed out while waiting for the automation command to finish.", {
            token,
            waitTimeoutMs
        });
    }

    private async getEtaRange() {
        const stats = await this.messageStore.getDurationStats(this.sessionIdValue);
        return {
            etaMinMs: stats.p50Ms ?? DEFAULT_ETA_MIN_MS,
            etaMaxMs: stats.p90Ms ?? Math.max(stats.p50Ms ?? 0, DEFAULT_ETA_MAX_MS)
        };
    }

    private getCurrentChatState(messages: PersistedMessageRecord[]): ChatStatusSummary["state"] {
        const activeMessage = [...messages]
            .sort((left, right) => right.message - left.message)
            .find((message) => message.status === "sending" || message.status === "pending");
        if (!activeMessage) {
            return "ready";
        }

        return activeMessage.status === "sending" ? "sending" : "waiting_response";
    }

    private assertSupportedChat(requestedChat?: number | null) {
        if (requestedChat == null || requestedChat === BRIDGE_CHAT_NUMBER) {
            return;
        }

        throw new HttpError(404, "The requested chat does not exist.", {
            chat: requestedChat
        });
    }

    async recordClientLog(source: string, level: LogLevel, message: string, context?: Record<string, unknown>) {
        await this.writeLog(level, source, message, context);
    }

    private getAutomationLaunch(token: string) {
        const launch = this.automationLaunches.get(token);
        if (!launch) {
            throw new HttpError(404, "Automation launch not found.", { token });
        }

        return launch;
    }

    private getAutomationCommand(token: string) {
        const command = this.automationCommands.get(token);
        if (!command) {
            throw new HttpError(404, "Automation command not found.", { token });
        }

        return command;
    }

    private createAutomationLaunch(isTemporary: boolean) {
        const createdAt = now();
        const launch: AutomationLaunchRecord = {
            token: randomUUID(),
            sessionId: this.sessionIdValue,
            isTemporary,
            status: "pending",
            detail: null,
            createdAt,
            updatedAt: createdAt
        };

        this.automationLaunches.set(launch.token, launch);
        this.lastAutomationLaunchToken = launch.token;
        return launch;
    }

    private prepareAutomationCommand(type: AutomationCommandType) {
        const createdAt = now();
        const command: AutomationCommandRecord = {
            token: randomUUID(),
            sessionId: this.sessionIdValue,
            type,
            status: "pending",
            detail: null,
            createdAt,
            updatedAt: createdAt
        };

        this.automationCommands.set(command.token, command);
        this.lastAutomationCommandToken = command.token;
        return command;
    }

    private async recordSuccessfulExchange(
        requestText: string,
        responseText: string,
        conversationUrl: string | null
    ) {
        const exchange: HistoryExchange = {
            requestText,
            responseText
        };
        const chatId = extractChatId(conversationUrl);
        if (!chatId) {
            this.pendingHistory.push(exchange);
            return;
        }

        const entries = [...this.pendingHistory, exchange];
        this.pendingHistory.length = 0;
        await this.appendHistoryEntries(chatId, entries);
    }

    private async appendHistoryEntries(chatId: string, entries: HistoryExchange[]) {
        if (entries.length === 0) {
            return;
        }

        const filePath = this.getHistoryFilePath(chatId);
        await mkdir(dirname(filePath), { recursive: true });
        const payload = entries.map(formatHistoryExchange).join("");
        await appendFile(filePath, payload, "utf8");
        await this.enforceHistorySizeLimit();
    }

    private async enforceHistorySizeLimit() {
        const directoryEntries = await readdir(this.paths.historyDir, { withFileTypes: true });
        const files = [];

        for (const entry of directoryEntries) {
            if (!entry.isFile()) {
                continue;
            }

            const fullPath = join(this.paths.historyDir, entry.name);
            const fileStat = await stat(fullPath);
            files.push({
                path: fullPath,
                size: fileStat.size,
                mtimeMs: fileStat.mtimeMs
            });
        }

        let totalSize = files.reduce((sum, file) => sum + file.size, 0);
        if (totalSize <= HISTORY_SIZE_LIMIT_BYTES) {
            return;
        }

        files.sort((left, right) => left.mtimeMs - right.mtimeMs);
        for (const file of files) {
            await rm(file.path, { force: true });
            totalSize -= file.size;
            this.logger.warn("[runtime] Deleted old chat history file due to history size limit.", file.path);
            if (totalSize <= HISTORY_SIZE_LIMIT_BYTES) {
                break;
            }
        }
    }

    private getHistoryFilePath(chatId: string) {
        return join(
            this.paths.historyDir,
            `${sanitizeFileSegment(this.sessionIdValue)}-${sanitizeFileSegment(chatId)}-chatHistory.log`
        );
    }

    private async readPersistedSessionState(): Promise<PersistedSessionState | null> {
        try {
            const raw = await readFile(this.getSessionStatePath(), "utf8");
            const parsed = JSON.parse(raw) as PersistedSessionState;
            if (!parsed || typeof parsed !== "object") {
                return null;
            }

            if (parsed.sessionId !== this.sessionIdValue) {
                return null;
            }

            if (parsed.conversationUrl !== null && typeof parsed.conversationUrl !== "string") {
                return null;
            }

            if (typeof parsed.updatedAt !== "string") {
                return null;
            }

            return parsed;
        } catch (error) {
            if (isFileNotFound(error)) {
                return null;
            }

            this.logger.warn("[runtime] Failed to read persisted session state.", error);
            return null;
        }
    }

    private async persistSessionState() {
        const payload: PersistedSessionState = {
            sessionId: this.sessionIdValue,
            conversationUrl: this.session.conversationUrl,
            updatedAt: this.session.updatedAt
        };

        await mkdir(this.paths.sessionsDir, { recursive: true });
        await writeFile(this.getSessionStatePath(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    }

    private getSessionStatePath() {
        return join(this.paths.sessionsDir, `${sanitizeFileSegment(this.sessionIdValue)}.json`);
    }

    private resetForFreshChat() {
        this.session.conversationUrl = null;
        this.session.freshChatRequired = true;
        this.session.mode = "normal";
        this.session.updatedAt = now();
        this.pendingHistory.length = 0;
        void this.messageStore.setChatTemporary(this.sessionIdValue, BRIDGE_CHAT_NUMBER, false);
    }

    private assertSessionId(sessionId: string) {
        if (normalizeSessionId(sessionId) !== this.sessionIdValue) {
            throw new HttpError(409, "The requested session does not belong to this bridge runtime.", {
                sessionId,
                expectedSessionId: this.sessionIdValue
            });
        }
    }

    private async writeLog(level: LogLevel, source: string, message: string, context?: Record<string, unknown>) {
        const timestamp = now();
        const normalizedMessage = message.trim();
        const contextText = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : "";
        const line = `${timestamp} [${level}] [${source}] ${normalizedMessage}${contextText}\n`;
        this.logger[level](`[${source}] ${normalizedMessage}`, context || {});
        await appendFile(this.getSessionLogPath(), line, "utf8");
    }

    private getSessionLogPath() {
        return join(this.paths.logsDir, `${sanitizeFileSegment(this.sessionIdValue)}${SESSION_LOG_FILE_SUFFIX}`);
    }
}

function resolveRuntimePaths(dataRootDir?: string): RuntimePaths {
    const root = dataRootDir || getDefaultDataRootDir();
    return {
        dataRootDir: root,
        historyDir: join(root, "chat-history"),
        logsDir: join(root, "logs"),
        sessionsDir: join(root, "sessions")
    };
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

function buildChatLaunchUrl(
    baseUrl: string,
    token: string,
    bridgePort: number,
    sessionId: string,
    isTemporary: boolean
) {
    const url = new URL(baseUrl);
    url.searchParams.delete("bridgeClaim");
    url.searchParams.delete("bridgePort");
    url.searchParams.delete("bridgeSessionId");
    url.searchParams.delete("bridgeTemporary");
    if (isTemporary) {
        url.searchParams.set("bridgeTemporary", "1");
        url.searchParams.set("temporary-chat", "true");
    } else {
        url.searchParams.delete("temporary-chat");
    }

    const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    hashParams.set("bridgeClaim", token);
    hashParams.set("bridgePort", `${bridgePort}`);
    hashParams.set("bridgeSessionId", sessionId);
    if (isTemporary) {
        hashParams.set("bridgeTemporary", "1");
    } else {
        hashParams.delete("bridgeTemporary");
    }
    url.hash = hashParams.toString();

    return url.toString();
}

function normalizeSessionId(sessionId: string): string {
    const normalized = sessionId.trim();
    if (!normalized) {
        throw new HttpError(400, "sessionId is required.");
    }

    return normalized;
}

function normalizeText(text: string): string {
    const normalized = text.trim();
    if (!normalized) {
        throw new HttpError(400, "text is required.");
    }

    return normalized;
}

function normalizeConversationUrl(conversationUrl: string): string {
    const normalized = conversationUrl.trim();
    if (!normalized) {
        throw new HttpError(400, "conversationUrl must not be empty.");
    }

    const url = new URL(normalized);
    if (url.origin !== "https://chatgpt.com") {
        throw new HttpError(400, "conversationUrl must point to https://chatgpt.com.");
    }

    return url.toString();
}

function normalizeResponseText(responseText: string): string | null {
    const normalized = responseText.replace(/\r\n?/g, "\n").trim();
    return normalized || null;
}

function toSessionView(session: SessionRecord): SessionView {
    return {
        ...session,
        targetUrl: session.conversationUrl ?? CHATGPT_HOME_URL
    };
}

function toJobView(job: JobRecord, session: SessionRecord): JobView {
    return {
        ...job,
        targetUrl: session.conversationUrl ?? CHATGPT_HOME_URL,
        freshChatRequired: session.freshChatRequired,
        mode: session.mode
    };
}

function extractChatId(conversationUrl: string | null | undefined) {
    if (!conversationUrl) {
        return null;
    }

    try {
        const url = new URL(conversationUrl);
        const match = url.pathname.match(/^\/c\/([^/?#]+)/);
        return match?.[1] || null;
    } catch {
        return null;
    }
}

function escapeLogValue(value: string) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r\n?/g, "\n").replace(/\n/g, "\\n");
}

function formatHistoryExchange(exchange: HistoryExchange) {
    return `Request: "${escapeLogValue(exchange.requestText)}"\nAnswer: "${escapeLogValue(exchange.responseText)}"\n`;
}

function toMessageStatusSummary(message: PersistedMessageRecord): MessageStatusSummary {
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

function computeElapsedMs(message: PersistedMessageRecord) {
    const endTimestamp = Date.parse(message.completedAt || now());
    const startTimestamp = Date.parse(message.createdAt);
    if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) {
        return 0;
    }

    return Math.max(0, endTimestamp - startTimestamp);
}

function sanitizeFileSegment(value: string) {
    return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function isFileNotFound(error: unknown) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
