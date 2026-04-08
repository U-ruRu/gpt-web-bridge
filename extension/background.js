const CHATGPT_HOME_URL = "https://chatgpt.com/";
const AGENT_CONFIG_KEY = "agentConfig";
const AUTOMATION_TABS_KEY = "automationTabs";
const LAST_AUTOMATION_TAB_ID_KEY = "lastAutomationTabId";
const DEBUG_LOGS_KEY = "debugLogs";
const DEBUG_LOG_LIMIT = 200;
const RECONNECT_DELAY_MS = 3000;
const CONNECT_TIMEOUT_MS = 10000;
const PARALLEL_CHATS_DEFAULT_MODE = "sequential_safe_timeout";
const SAFE_TIMEOUT_MIN_MS = 3000;
const SAFE_TIMEOUT_MAX_MS = 10000;

let agentSocket = null;
let reconnectTimer = null;
let connectTimeoutTimer = null;
let connectionAttemptId = 0;
let nextJobSequence = 1;
let globalSendLock = null;
let globalSendCooldownUntil = 0;
let agentConnectionState = {
    status: "idle",
    detail: null,
    serverUrl: null,
    agentId: null,
    userId: null,
    connected: false
};

const pendingLaunches = new Map();
const pendingJobs = new Map();
const pendingCommands = new Map();
const dispatchedJobs = new Map();

browser.action.onClicked.addListener(async () => {
    await openAutomationWorkspace("browser-action");
});

async function openAutomationWorkspace(reason) {
    const config = await getAgentConfig();
    if (!config) {
        await browser.runtime.openOptionsPage();
        return;
    }

    await connectAgentIfConfigured(reason);
    const focused = await focusLastAutomationTab();
    if (!focused) {
        await browser.tabs.create({
            url: CHATGPT_HOME_URL,
            active: true
        });
    }
}

browser.runtime.onInstalled.addListener(async () => {
    await browser.storage.local.remove([AUTOMATION_TABS_KEY, LAST_AUTOMATION_TAB_ID_KEY, DEBUG_LOGS_KEY]);
    await appendDebugLog("background", "info", "Extension installed and automation state cleared.", {});
    await connectAgentIfConfigured("onInstalled");
});

browser.runtime.onStartup.addListener(async () => {
    await connectAgentIfConfigured("onStartup");
});

browser.tabs.onRemoved.addListener(async (tabId) => {
    await appendDebugLog("background", "info", "Tab removed.", { tabId });
    await removeAutomationTab(tabId);
});

browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === "saveAgentConfig") {
        return saveAgentConfig(message.config || {});
    }

    if (message?.type === "loadAgentConfig") {
        return getAgentConfig();
    }

    if (message?.type === "getAgentStatus") {
        return getAgentStatus();
    }

    if (message?.type === "openAutomationWorkspace") {
        return openAutomationWorkspace("popup-open-chat");
    }

    if (message?.type === "openSettingsPage") {
        return openSettingsPage();
    }

    if (message?.type === "isAutomationTab") {
        return isSenderAutomationTab(sender);
    }

    if (message?.type === "getAutomationContext") {
        return getAutomationContext(sender);
    }

    if (message?.type === "claimAutomationTab") {
        return claimAutomationTab(sender);
    }

    if (message?.type === "getPendingAutomationCommand") {
        return getPendingAutomationCommand(sender);
    }

    if (message?.type === "getPendingJob") {
        return getPendingJob(sender);
    }

    if (message?.type === "reportSessionReady") {
        return reportSessionReady(sender, message);
    }

    if (message?.type === "reportSessionError") {
        return reportSessionError(sender, message);
    }

    if (message?.type === "reportJobResult") {
        return reportJobResult(sender, message);
    }

    if (message?.type === "reportJobAccepted") {
        return reportJobAccepted(sender, message);
    }

    if (message?.type === "reportAutomationCommandResult") {
        return reportAutomationCommandResult(sender, message);
    }

    if (message?.type === "debugLog") {
        return appendDebugLog(message.source || "content-script", message.level || "info", message.message || "", message.context || {});
    }

    return undefined;
});

void connectAgentIfConfigured("background-script");

async function saveAgentConfig(config) {
    const normalized = normalizeAgentConfig(config);
    if (!normalized) {
        await browser.storage.local.remove(AGENT_CONFIG_KEY);
        disconnectAgentSocket("Agent configuration was cleared.");
        return { ok: true, cleared: true };
    }

    await browser.storage.local.set({
        [AGENT_CONFIG_KEY]: normalized
    });
    await appendDebugLog("background", "info", "Agent configuration was saved.", {
        serverUrl: normalized.serverUrl
    });
    disconnectAgentSocket("Agent configuration changed.");
    await connectAgentIfConfigured("save-config");
    return { ok: true, cleared: false };
}

async function getAgentConfig() {
    const result = await browser.storage.local.get(AGENT_CONFIG_KEY);
    return normalizeAgentConfig(result[AGENT_CONFIG_KEY]);
}

function normalizeAgentConfig(value) {
    if (!isPlainObject(value)) {
        return null;
    }

    const serverUrl = normalizeHttpServerUrl(value.serverUrl);
    const serverAccessToken = normalizeNullableString(value.serverAccessToken);
    const userToken = normalizeNullableString(value.userToken);
    const parallelChatsMode = normalizeParallelChatsMode(value.parallelChatsMode) || PARALLEL_CHATS_DEFAULT_MODE;
    if (!serverUrl || !serverAccessToken || !userToken) {
        return null;
    }

    return {
        serverUrl,
        serverAccessToken,
        userToken,
        parallelChatsMode
    };
}

async function connectAgentIfConfigured(reason) {
    const config = await getAgentConfig();
    if (!config) {
        agentConnectionState = {
            status: "idle",
            detail: "Agent is not configured yet.",
            serverUrl: null,
            agentId: null,
            userId: null,
            connected: false
        };
        return { ...agentConnectionState };
    }

    if (agentSocket && (agentSocket.readyState === WebSocket.OPEN || agentSocket.readyState === WebSocket.CONNECTING)) {
        return { ...agentConnectionState };
    }

    clearReconnectTimer();
    clearConnectTimeoutTimer();
    connectionAttemptId += 1;
    const attemptId = connectionAttemptId;
    const websocketUrl = toAgentWebSocketUrl(config.serverUrl);
    agentConnectionState = {
        ...agentConnectionState,
        status: "connecting",
        detail: `Connecting to ${config.serverUrl} (${reason}).`,
        serverUrl: config.serverUrl,
        connected: false
    };
    await appendDebugLog("background", "info", "Connecting browser agent.", {
        reason,
        serverUrl: config.serverUrl
    });

    const socket = new WebSocket(websocketUrl);
    agentSocket = socket;
    startConnectTimeout(attemptId, socket, config.serverUrl);

    socket.addEventListener("open", async () => {
        if (attemptId !== connectionAttemptId) {
            socket.close();
            return;
        }

        agentConnectionState = {
            ...agentConnectionState,
            status: "connecting",
            detail: "WebSocket is open. Waiting for the server confirmation.",
            connected: false
        };
        await appendDebugLog("background", "info", "WebSocket connection is open. Waiting for agent.ready.", {
            serverUrl: config.serverUrl
        });
        sendToAgent({
            type: "agent.hello",
            serverAccessToken: config.serverAccessToken,
            userToken: config.userToken,
            browserName: "firefox"
        });
    });

    socket.addEventListener("message", async (event) => {
        if (attemptId !== connectionAttemptId) {
            return;
        }

        try {
            const message = JSON.parse(event.data);
            await handleAgentMessage(message);
        } catch (error) {
            await appendDebugLog("background", "error", "Failed to handle a WebSocket message.", {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    });

    socket.addEventListener("close", async (event) => {
        if (attemptId !== connectionAttemptId) {
            return;
        }

        clearConnectTimeoutTimer();
        agentSocket = null;
        const closeDetail = formatSocketCloseDetail(event);
        const shouldPreserveError = agentConnectionState.status === "error" && Boolean(agentConnectionState.detail);
        agentConnectionState = {
            ...agentConnectionState,
            status: shouldPreserveError ? "error" : "disconnected",
            detail: shouldPreserveError ? agentConnectionState.detail : closeDetail,
            connected: false
        };
        await appendDebugLog("background", "warn", "Browser agent disconnected.", {
            serverUrl: config.serverUrl,
            code: event.code,
            reason: event.reason || null,
            wasClean: Boolean(event.wasClean)
        });
        scheduleReconnect("socket-close");
    });

    socket.addEventListener("error", async () => {
        if (attemptId !== connectionAttemptId) {
            return;
        }

        clearConnectTimeoutTimer();
        agentConnectionState = {
            ...agentConnectionState,
            status: "error",
            detail: "Failed to open the browser-agent WebSocket. Check the server URL and whether the server is running.",
            connected: false
        };
        await appendDebugLog("background", "error", "WebSocket connection failed.", {
            serverUrl: config.serverUrl
        });
    });

    return { ...agentConnectionState };
}

function disconnectAgentSocket(detail) {
    clearReconnectTimer();
    clearConnectTimeoutTimer();
    resetSchedulerState();
    connectionAttemptId += 1;
    if (agentSocket) {
        try {
            agentSocket.close();
        } catch {
            return;
        } finally {
            agentSocket = null;
        }
    }

    agentConnectionState = {
        ...agentConnectionState,
        status: "idle",
        detail: detail || null,
        connected: false
    };
}

function scheduleReconnect(reason) {
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connectAgentIfConfigured(reason);
    }, RECONNECT_DELAY_MS);
}

function clearReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function startConnectTimeout(attemptId, socket, serverUrl) {
    clearConnectTimeoutTimer();
    connectTimeoutTimer = setTimeout(() => {
        if (attemptId !== connectionAttemptId || socket !== agentSocket || agentConnectionState.status === "ready") {
            return;
        }

        agentConnectionState = {
            ...agentConnectionState,
            status: "error",
            detail: "Timed out while waiting for the server response. Check the server URL, access token, and server logs.",
            connected: false
        };
        void appendDebugLog("background", "error", "Timed out while waiting for agent.ready.", {
            serverUrl,
            timeoutMs: CONNECT_TIMEOUT_MS
        });

        try {
            socket.close();
        } catch {
            // Ignore close failures for already-closed sockets.
        }
    }, CONNECT_TIMEOUT_MS);
}

function clearConnectTimeoutTimer() {
    if (connectTimeoutTimer) {
        clearTimeout(connectTimeoutTimer);
        connectTimeoutTimer = null;
    }
}

function sendToAgent(message) {
    if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
        throw new Error("The browser agent is not connected.");
    }

    agentSocket.send(JSON.stringify(message));
}

async function handleAgentMessage(message) {
    if (message?.type === "agent.ready") {
        clearConnectTimeoutTimer();
        agentConnectionState = {
            status: "ready",
            detail: "Browser agent is connected.",
            serverUrl: agentConnectionState.serverUrl,
            agentId: normalizeNullableString(message.agentId),
            userId: normalizeNullableString(message.userId),
            connected: true
        };
        await appendDebugLog("background", "info", "Browser agent is ready.", {
            agentId: agentConnectionState.agentId,
            userId: agentConnectionState.userId
        });
        return;
    }

    if (message?.type === "agent.error") {
        clearConnectTimeoutTimer();
        agentConnectionState = {
            ...agentConnectionState,
            status: "error",
            detail: normalizeNullableString(message.message) || "Agent error",
            connected: false
        };
        await appendDebugLog("background", "error", "Browser agent reported an error.", {
            message: message.message || null
        });
        return;
    }

    if (message?.type === "ping") {
        sendToAgent({
            type: "pong",
            timestamp: message.timestamp || new Date().toISOString()
        });
        return;
    }

    if (message?.type === "session.start") {
        await queueSessionStart(message);
        return;
    }

    if (message?.type === "session.ask") {
        queueSessionJob(message.sessionToken, {
            commandId: message.commandId,
            request: message.request
        });
        await appendDebugLog("background", "info", "Queued a session ask request.", {
            sessionToken: message.sessionToken,
            commandId: message.commandId
        });
        return;
    }

    if (message?.type === "session.setTemporary") {
        queueSessionCommand(message.sessionToken, {
            commandId: message.commandId,
            type: "set-temporary"
        });
        await appendDebugLog("background", "info", "Queued a temporary-mode command.", {
            sessionToken: message.sessionToken,
            commandId: message.commandId
        });
        return;
    }

    if (message?.type === "session.release") {
        await releaseSessionTab(message.sessionToken, message.commandId);
    }
}

async function queueSessionStart(message) {
    pendingLaunches.set(message.sessionToken, {
        commandId: message.commandId,
        openInTemporaryMode: Boolean(message.openInTemporaryMode)
    });

    const createdTab = await browser.tabs.create({
        url: message.targetUrl || CHATGPT_HOME_URL,
        active: true
    });

    if (typeof createdTab.id !== "number") {
        pendingLaunches.delete(message.sessionToken);
        sendToAgent({
            type: "session.error",
            commandId: message.commandId,
            sessionToken: message.sessionToken,
            detail: "Failed to create an automation tab."
        });
        return;
    }

    await setAutomationTabMetadata(createdTab.id, {
        sessionToken: message.sessionToken,
        isTemporary: Boolean(message.openInTemporaryMode),
        launchPending: true,
        conversationUrl: null
    });
    await setLastAutomationTabId(createdTab.id);
    await appendDebugLog("background", "info", "Created a new automation tab for a session.", {
        tabId: createdTab.id,
        sessionToken: message.sessionToken,
        openInTemporaryMode: Boolean(message.openInTemporaryMode)
    });
}

function queueSessionJob(sessionToken, job) {
    const queue = pendingJobs.get(sessionToken) || [];
    queue.push({
        ...job,
        sequence: nextJobSequence++
    });
    pendingJobs.set(sessionToken, queue);
}

function getParallelChatsMode(config) {
    return normalizeParallelChatsMode(config?.parallelChatsMode) || PARALLEL_CHATS_DEFAULT_MODE;
}

function isSequentialParallelChatsMode(mode) {
    return mode === "sequential" || mode === "sequential_safe_timeout";
}

function getNextQueuedJobEntry() {
    let nextEntry = null;
    for (const [sessionToken, queue] of pendingJobs.entries()) {
        if (!Array.isArray(queue) || queue.length === 0) {
            continue;
        }

        const candidate = queue[0];
        if (!nextEntry || candidate.sequence < nextEntry.job.sequence) {
            nextEntry = {
                sessionToken,
                job: candidate
            };
        }
    }

    return nextEntry;
}

function canDispatchQueuedJob(mode, sessionToken, job) {
    if (mode === "parallel") {
        return true;
    }

    if (!isSequentialParallelChatsMode(mode)) {
        return true;
    }

    if (globalSendLock && globalSendLock.commandId !== job.commandId) {
        return false;
    }

    if (Date.now() < globalSendCooldownUntil) {
        return false;
    }

    const nextEntry = getNextQueuedJobEntry();
    return Boolean(nextEntry && nextEntry.sessionToken === sessionToken && nextEntry.job.commandId === job.commandId);
}

function markJobDispatched(mode, sessionToken, job) {
    dispatchedJobs.set(job.commandId, {
        sessionToken,
        accepted: false
    });

    if (isSequentialParallelChatsMode(mode)) {
        globalSendLock = {
            sessionToken,
            commandId: job.commandId
        };
    }
}

function releaseDispatchGate(commandId, useSafeDelay) {
    if (!globalSendLock || globalSendLock.commandId !== commandId) {
        return;
    }

    globalSendLock = null;
    if (useSafeDelay) {
        globalSendCooldownUntil = Date.now() + randomBetween(SAFE_TIMEOUT_MIN_MS, SAFE_TIMEOUT_MAX_MS);
        return;
    }

    globalSendCooldownUntil = 0;
}

function resetSchedulerState() {
    globalSendLock = null;
    globalSendCooldownUntil = 0;
    dispatchedJobs.clear();
}

function queueSessionCommand(sessionToken, command) {
    const queue = pendingCommands.get(sessionToken) || [];
    queue.push(command);
    pendingCommands.set(sessionToken, queue);
}

async function releaseSessionTab(sessionToken, commandId) {
    const tab = await findAutomationTabBySessionToken(sessionToken);
    if (tab?.tabId) {
        await removeAutomationTab(tab.tabId);
        try {
            await browser.tabs.remove(tab.tabId);
        } catch {
            // Ignore tabs that are already gone.
        }
    }

    pendingJobs.delete(sessionToken);
    pendingCommands.delete(sessionToken);
    pendingLaunches.delete(sessionToken);
    for (const [queuedCommandId, job] of dispatchedJobs.entries()) {
        if (job.sessionToken !== sessionToken) {
            continue;
        }

        if (globalSendLock?.commandId === queuedCommandId) {
            releaseDispatchGate(queuedCommandId, false);
        }
        dispatchedJobs.delete(queuedCommandId);
    }
    sendToAgent({
        type: "session.released",
        commandId,
        sessionToken,
        detail: "Session tab was released."
    });
}

async function getAgentStatus() {
    return {
        ...agentConnectionState,
        hasConfiguration: Boolean(await getAgentConfig())
    };
}

async function openSettingsPage() {
    await browser.runtime.openOptionsPage();
    return { ok: true };
}

async function isSenderAutomationTab(sender) {
    const metadata = await getSenderAutomationTabMetadata(sender);
    return {
        isAutomationTab: Boolean(metadata),
        metadata: metadata || null
    };
}

async function getAutomationContext(sender) {
    const metadata = await getSenderAutomationTabMetadata(sender);
    return {
        context: metadata
    };
}

async function claimAutomationTab(sender) {
    if (typeof sender.tab?.id !== "number") {
        return {
            ok: false,
            error: "Sender tab id is missing."
        };
    }

    const metadata = await getAutomationTabMetadata(sender.tab.id);
    if (!metadata) {
        return {
            ok: false,
            error: "The current tab is not bound to a chat session."
        };
    }

    await setAutomationTabMetadata(sender.tab.id, {
        ...metadata,
        launchPending: false
    });
    await setLastAutomationTabId(sender.tab.id);
    return {
        ok: true,
        metadata: {
            ...metadata,
            launchPending: false
        }
    };
}

async function getPendingAutomationCommand(sender) {
    const metadata = await getSenderAutomationTabMetadata(sender);
    if (!metadata?.sessionToken) {
        return null;
    }

    const queue = pendingCommands.get(metadata.sessionToken) || [];
    if (!queue.length) {
        return null;
    }

    const nextCommand = queue.shift();
    pendingCommands.set(metadata.sessionToken, queue);
    return nextCommand || null;
}

async function getPendingJob(sender) {
    const metadata = await getSenderAutomationTabMetadata(sender);
    if (!metadata?.sessionToken) {
        return null;
    }

    const queue = pendingJobs.get(metadata.sessionToken) || [];
    if (!queue.length) {
        return null;
    }

    const config = await getAgentConfig();
    const parallelChatsMode = getParallelChatsMode(config);
    const nextJob = queue[0];
    if (!canDispatchQueuedJob(parallelChatsMode, metadata.sessionToken, nextJob)) {
        return null;
    }

    queue.shift();
    pendingJobs.set(metadata.sessionToken, queue);
    markJobDispatched(parallelChatsMode, metadata.sessionToken, nextJob);
    return nextJob || null;
}

async function reportSessionReady(sender, message) {
    const metadata = await getSenderAutomationTabMetadata(sender);
    if (!metadata?.sessionToken) {
        return {
            ok: false,
            error: "The sender tab is not bound to a session."
        };
    }

    const pendingLaunch = pendingLaunches.get(metadata.sessionToken);
    if (!pendingLaunch) {
        return {
            ok: false,
            error: "No pending launch was found for this session."
        };
    }

    if (typeof sender.tab?.id === "number") {
        await setAutomationTabMetadata(sender.tab.id, {
            ...metadata,
            launchPending: false,
            isTemporary: Boolean(message?.isTemporary ?? metadata.isTemporary),
            conversationUrl: normalizeNullableString(message?.conversationUrl) || metadata.conversationUrl
        });
    }

    pendingLaunches.delete(metadata.sessionToken);
    sendToAgent({
        type: "session.ready",
        commandId: pendingLaunch.commandId,
        sessionToken: metadata.sessionToken,
        tabId: sender.tab?.id,
        detail: normalizeNullableString(message?.detail) || "The automation tab is ready.",
        conversationUrl: normalizeNullableString(message?.conversationUrl) || null,
        mode: message?.isTemporary ? "temporary" : "normal"
    });
    return { ok: true };
}

async function reportSessionError(sender, message) {
    const metadata = await getSenderAutomationTabMetadata(sender);
    if (!metadata?.sessionToken) {
        return {
            ok: false,
            error: "The sender tab is not bound to a session."
        };
    }

    const pendingLaunch = pendingLaunches.get(metadata.sessionToken);
    if (!pendingLaunch) {
        return {
            ok: false,
            error: "No pending launch exists for this session."
        };
    }

    pendingLaunches.delete(metadata.sessionToken);
    sendToAgent({
        type: "session.error",
        commandId: pendingLaunch.commandId,
        sessionToken: metadata.sessionToken,
        detail: normalizeNullableString(message?.detail) || "The automation tab failed to initialize."
    });
    return { ok: true };
}

async function reportJobAccepted(sender, message) {
    const metadata = await getSenderAutomationTabMetadata(sender);
    if (!metadata?.sessionToken) {
        return {
            ok: false,
            error: "The sender tab is not bound to a session."
        };
    }

    const commandId = normalizeNullableString(message?.commandId);
    if (!commandId) {
        return {
            ok: false,
            error: "commandId is required."
        };
    }

    const dispatchedJob = dispatchedJobs.get(commandId);
    if (!dispatchedJob) {
        return {
            ok: false,
            error: "The job is not tracked as dispatched."
        };
    }

    const detail = normalizeNullableString(message?.detail) || "Prompt was sent.";
    const conversationUrl = normalizeConversationUrl(message?.conversationUrl);
    if (typeof sender.tab?.id === "number") {
        await setAutomationTabMetadata(sender.tab.id, {
            ...metadata,
            conversationUrl: conversationUrl || metadata.conversationUrl
        });
    }

    dispatchedJob.accepted = true;
    dispatchedJobs.set(commandId, dispatchedJob);
    const mode = getParallelChatsMode(await getAgentConfig());
    releaseDispatchGate(commandId, mode === "sequential_safe_timeout");

    sendToAgent({
        type: "session.askAccepted",
        commandId,
        sessionToken: metadata.sessionToken,
        detail,
        conversationUrl: conversationUrl || null,
        mode: metadata.isTemporary ? "temporary" : "normal"
    });
    return { ok: true };
}

async function reportJobResult(sender, message) {
    const metadata = await getSenderAutomationTabMetadata(sender);
    if (!metadata?.sessionToken) {
        return {
            ok: false,
            error: "The sender tab is not bound to a session."
        };
    }

    const commandId = normalizeNullableString(message?.commandId);
    if (!commandId) {
        return {
            ok: false,
            error: "commandId is required."
        };
    }

    const detail = normalizeNullableString(message?.detail);
    const conversationUrl = normalizeConversationUrl(message?.conversationUrl);
    const dispatchedJob = dispatchedJobs.get(commandId) || null;
    if (typeof sender.tab?.id === "number") {
        await setAutomationTabMetadata(sender.tab.id, {
            ...metadata,
            conversationUrl: conversationUrl || metadata.conversationUrl
        });
    }

    if (message?.status === "failed") {
        if (dispatchedJob && !dispatchedJob.accepted) {
            releaseDispatchGate(commandId, false);
        }
        dispatchedJobs.delete(commandId);
        sendToAgent({
            type: "session.error",
            commandId,
            sessionToken: metadata.sessionToken,
            detail: detail || "The prompt execution failed."
        });
        return { ok: true };
    }

    if (dispatchedJob && !dispatchedJob.accepted) {
        dispatchedJob.accepted = true;
        dispatchedJobs.set(commandId, dispatchedJob);
        const mode = getParallelChatsMode(await getAgentConfig());
        releaseDispatchGate(commandId, mode === "sequential_safe_timeout");
        sendToAgent({
            type: "session.askAccepted",
            commandId,
            sessionToken: metadata.sessionToken,
            detail: "Prompt was sent.",
            conversationUrl: conversationUrl || null,
            mode: metadata.isTemporary ? "temporary" : "normal"
        });
    }

    dispatchedJobs.delete(commandId);
    sendToAgent({
        type: "session.askResult",
        commandId,
        sessionToken: metadata.sessionToken,
        detail: detail || "Assistant response captured.",
        responseText: `${message?.responseText || ""}`,
        conversationUrl: conversationUrl || null,
        mode: metadata.isTemporary ? "temporary" : "normal"
    });
    return { ok: true };
}

async function reportAutomationCommandResult(sender, message) {
    const metadata = await getSenderAutomationTabMetadata(sender);
    if (!metadata?.sessionToken) {
        return {
            ok: false,
            error: "The sender tab is not bound to a session."
        };
    }

    const commandId = normalizeNullableString(message?.commandId);
    if (!commandId) {
        return {
            ok: false,
            error: "commandId is required."
        };
    }

    if (message?.status === "failed") {
        sendToAgent({
            type: "session.error",
            commandId,
            sessionToken: metadata.sessionToken,
            detail: normalizeNullableString(message?.detail) || "The automation command failed."
        });
        return { ok: true };
    }

    if (typeof sender.tab?.id === "number") {
        await setAutomationTabMetadata(sender.tab.id, {
            ...metadata,
            isTemporary: Boolean(message?.isTemporary ?? true)
        });
    }

    sendToAgent({
        type: "session.commandResult",
        commandId,
        sessionToken: metadata.sessionToken,
        detail: normalizeNullableString(message?.detail) || "Temporary chat mode is enabled.",
        mode: message?.isTemporary === false ? "normal" : "temporary"
    });
    return { ok: true };
}

async function focusLastAutomationTab() {
    const tabId = await getLastAutomationTabId();
    if (typeof tabId !== "number") {
        return false;
    }

    try {
        const tab = await browser.tabs.get(tabId);
        if (!tab.id) {
            return false;
        }

        await focusTab(tab);
        return true;
    } catch {
        return false;
    }
}

async function getSenderAutomationTabMetadata(sender) {
    if (typeof sender.tab?.id !== "number") {
        return null;
    }

    return await getAutomationTabMetadata(sender.tab.id);
}

async function getAutomationTabs() {
    const result = await browser.storage.local.get(AUTOMATION_TABS_KEY);
    const storedValue = result[AUTOMATION_TABS_KEY];
    return isPlainObject(storedValue) ? storedValue : {};
}

async function getAutomationTabMetadata(tabId) {
    const automationTabs = await getAutomationTabs();
    const metadata = automationTabs[String(tabId)];
    return isPlainObject(metadata) ? metadata : null;
}

async function findAutomationTabBySessionToken(sessionToken) {
    const automationTabs = await getAutomationTabs();
    for (const [tabId, metadata] of Object.entries(automationTabs)) {
        if (metadata?.sessionToken === sessionToken) {
            return {
                tabId: Number.parseInt(tabId, 10),
                metadata
            };
        }
    }

    return null;
}

async function setAutomationTabMetadata(tabId, metadata) {
    const automationTabs = await getAutomationTabs();
    automationTabs[String(tabId)] = {
        sessionToken: normalizeNullableString(metadata.sessionToken),
        launchPending: Boolean(metadata.launchPending),
        isTemporary: Boolean(metadata.isTemporary),
        conversationUrl: normalizeConversationUrl(metadata.conversationUrl),
        updatedAt: new Date().toISOString()
    };
    await browser.storage.local.set({ [AUTOMATION_TABS_KEY]: automationTabs });
}

async function removeAutomationTab(tabId) {
    const automationTabs = await getAutomationTabs();
    if (automationTabs[String(tabId)] === undefined) {
        const lastAutomationTabId = await getLastAutomationTabId();
        if (lastAutomationTabId === tabId) {
            await browser.storage.local.remove(LAST_AUTOMATION_TAB_ID_KEY);
        }
        return;
    }

    delete automationTabs[String(tabId)];
    await browser.storage.local.set({ [AUTOMATION_TABS_KEY]: automationTabs });
    const lastAutomationTabId = await getLastAutomationTabId();
    if (lastAutomationTabId === tabId) {
        await browser.storage.local.remove(LAST_AUTOMATION_TAB_ID_KEY);
    }
}

async function getLastAutomationTabId() {
    const result = await browser.storage.local.get(LAST_AUTOMATION_TAB_ID_KEY);
    return typeof result[LAST_AUTOMATION_TAB_ID_KEY] === "number" ? result[LAST_AUTOMATION_TAB_ID_KEY] : null;
}

async function setLastAutomationTabId(tabId) {
    await browser.storage.local.set({ [LAST_AUTOMATION_TAB_ID_KEY]: tabId });
}

async function focusTab(tab) {
    if (typeof tab.windowId === "number") {
        await browser.windows.update(tab.windowId, { focused: true });
    }

    if (typeof tab.id === "number") {
        await browser.tabs.update(tab.id, { active: true });
    }
}

function normalizeHttpServerUrl(value) {
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    try {
        const url = new URL(trimmed);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return null;
        }

        url.hash = "";
        url.search = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return null;
    }
}

function toAgentWebSocketUrl(serverUrl) {
    const url = new URL(serverUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/agent/ws`;
    url.search = "";
    url.hash = "";
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
}

function formatSocketCloseDetail(event) {
    const code = typeof event?.code === "number" ? event.code : 0;
    const reason = normalizeNullableString(event?.reason);
    if (reason) {
        return `WebSocket connection is closed (code ${code}: ${reason}).`;
    }

    if (code) {
        return `WebSocket connection is closed (code ${code}).`;
    }

    return "WebSocket connection is closed.";
}

function normalizeParallelChatsMode(value) {
    if (value === "parallel" || value === "sequential" || value === "sequential_safe_timeout") {
        return value;
    }

    return null;
}

function normalizeConversationUrl(value) {
    const normalized = normalizeNullableString(value);
    if (!normalized) {
        return null;
    }

    try {
        const url = new URL(normalized);
        if (url.origin !== "https://chatgpt.com") {
            return null;
        }

        return url.href;
    } catch {
        return null;
    }
}

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalizeNullableString(value) {
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();
    return trimmed || null;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function appendDebugLog(source, level, message, context) {
    const normalizedSource = normalizeNullableString(source) || "extension";
    const normalizedLevel = ["debug", "info", "warn", "error"].includes(level) ? level : "info";
    const normalizedMessage = `${message || ""}`.trim();
    if (!normalizedMessage) {
        return { ok: true };
    }

    const result = await browser.storage.local.get(DEBUG_LOGS_KEY);
    const currentLogs = Array.isArray(result[DEBUG_LOGS_KEY]) ? result[DEBUG_LOGS_KEY] : [];
    currentLogs.push({
        timestamp: new Date().toISOString(),
        source: normalizedSource,
        level: normalizedLevel,
        message: normalizedMessage,
        context: isPlainObject(context) ? context : {}
    });

    await browser.storage.local.set({
        [DEBUG_LOGS_KEY]: currentLogs.slice(-DEBUG_LOG_LIMIT)
    });
    return { ok: true };
}
