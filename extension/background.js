const CHATGPT_HOME_URL = "https://chatgpt.com/";
const AUTOMATION_TABS_KEY = "automationTabs";
const LAST_AUTOMATION_TAB_ID_KEY = "lastAutomationTabId";
const DEBUG_LOGS_KEY = "debugLogs";
const DEBUG_LOG_LIMIT = 200;
const BRIDGE_CLAIM_QUERY_PARAM = "bridgeClaim";
const BRIDGE_PORT_QUERY_PARAM = "bridgePort";
const BRIDGE_SESSION_QUERY_PARAM = "bridgeSessionId";
const BRIDGE_TEMPORARY_QUERY_PARAM = "bridgeTemporary";
const NATIVE_HOST_NAME = "chatgpt_web_bridge_host";
const DEFAULT_NATIVE_BRIDGE_HOST = "127.0.0.1";
const DEFAULT_NATIVE_BRIDGE_PORT = 4545;
const DEFAULT_NATIVE_BRIDGE_SESSION_ID = "api";
const NATIVE_BRIDGE_READY_TIMEOUT_MS = 15000;

let nativeHostPort = null;
let nativeHostConnectPromise = null;
let nativeBridgeState = {
    status: "idle",
    baseUrl: null,
    sessionId: null,
    detail: null,
    pid: null,
    source: "none",
    connected: false,
    lastError: null
};

browser.action.onClicked.addListener(async () => {
    await appendDebugLog("background", "info", "Browser action clicked.", {});
    await ensureNativeBridgeHost("browser-action");
    await ensureAutomationTab();
});

browser.runtime.onInstalled.addListener(async () => {
    await browser.storage.local.remove([AUTOMATION_TABS_KEY, LAST_AUTOMATION_TAB_ID_KEY, DEBUG_LOGS_KEY]);
    logBackground("info", "Extension installed and automation state cleared.", {});
    await ensureNativeBridgeHost("onInstalled");
});

browser.runtime.onStartup.addListener(async () => {
    await ensureNativeBridgeHost("onStartup");
});

browser.tabs.onRemoved.addListener(async (tabId) => {
    await appendDebugLog("background", "info", "Tab removed.", { tabId });
    await removeAutomationTab(tabId);
});

browser.tabs.onCreated.addListener(async (tab) => {
    await appendDebugLog("background", "info", "Tab created.", {
        tabId: tab.id || null,
        url: tab.url || null
    });
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const nextUrl = typeof changeInfo.url === "string" ? changeInfo.url : tab.url;
    if (!nextUrl || !nextUrl.startsWith("https://chatgpt.com/")) {
        return;
    }

    const launchContext = parseLaunchContext(nextUrl);
    await appendDebugLog("background", launchContext ? "info" : "debug", "Observed ChatGPT tab update.", {
        tabId,
        status: normalizeNullableString(changeInfo.status),
        nextUrl,
        hasLaunchContext: Boolean(launchContext),
        bridgeBaseUrl: launchContext?.bridgeBaseUrl || null,
        sessionId: launchContext?.sessionId || null,
        isTemporary: launchContext?.isTemporary || false
    });

    if (!launchContext) {
        return;
    }

    const existingMetadata = await getAutomationTabMetadata(tabId);
    const launchPending = resolveLaunchPending(existingMetadata, launchContext);
    await setAutomationTabMetadata(tabId, {
        ...(existingMetadata || {}),
        ...launchContext,
        launchPending
    });
    logBackground(launchPending ? "info" : "debug", "Stored launch context for tab.", {
        tabId,
        bridgeBaseUrl: launchContext.bridgeBaseUrl,
        sessionId: launchContext.sessionId,
        isTemporary: launchContext.isTemporary,
        launchPending
    });
    await emitBridgeLog(launchContext.bridgeBaseUrl, "background", "info", "Stored launch context for tab.", {
        tabId,
        sessionId: launchContext.sessionId,
        isTemporary: launchContext.isTemporary,
        nextUrl,
        launchPending
    });
});

browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === "isAutomationTab") {
        return isSenderAutomationTab(sender);
    }

    if (message?.type === "isActiveTab") {
        return isSenderActiveTab(sender);
    }

    if (message?.type === "getBridgeContext") {
        return getBridgeContext(sender);
    }

    if (message?.type === "claimAutomationTab") {
        return claimAutomationTab(sender, message);
    }

    if (message?.type === "ensureAutomationTab") {
        return ensureAutomationTab();
    }

    if (message?.type === "bridgeRequest") {
        return proxyBridgeRequest(message, sender);
    }

    if (message?.type === "debugLog") {
        return appendDebugLog(message.source || "content-script", message.level || "info", message.message || "", message.context || {});
    }

    return undefined;
});

async function ensureAutomationTab() {
    await ensureNativeBridgeHost("ensureAutomationTab");
    const automationTabs = await getAutomationTabs();
    const lastAutomationTabId = await getLastAutomationTabId();
    const candidateTabIds = [];

    if (typeof lastAutomationTabId === "number") {
        candidateTabIds.push(lastAutomationTabId);
    }

    for (const key of Object.keys(automationTabs)) {
        const tabId = Number.parseInt(key, 10);
        if (Number.isInteger(tabId) && !candidateTabIds.includes(tabId)) {
            candidateTabIds.push(tabId);
        }
    }

    for (const tabId of candidateTabIds) {
        try {
            const tab = await browser.tabs.get(tabId);
            if (tab.url?.startsWith("https://chatgpt.com/")) {
                await focusTab(tab);
                await appendDebugLog("background", "info", "Reused existing automation tab.", {
                    tabId,
                    url: tab.url
                });
                return { tabId: tab.id, reused: true };
            }
        } catch (error) {
            logBackground("warn", "Stored automation tab is no longer available.", {
                tabId,
                error: error instanceof Error ? error.message : String(error)
            });
            await removeAutomationTab(tabId);
        }
    }

    const createdTab = await browser.tabs.create({
        url: CHATGPT_HOME_URL,
        active: true
    });

    if (typeof createdTab.id === "number") {
        await setLastAutomationTabId(createdTab.id);
    }

    await appendDebugLog("background", "info", "Created new automation tab.", {
        tabId: createdTab.id || null,
        url: createdTab.url || CHATGPT_HOME_URL
    });

    return { tabId: createdTab.id, reused: false };
}

void ensureNativeBridgeHost("background-script");

async function isSenderAutomationTab(sender) {
    const metadata = await getSenderAutomationTabMetadata(sender);
    return {
        isAutomationTab: Boolean(metadata && metadata.launchPending !== true),
        metadata: metadata || null
    };
}

async function claimAutomationTab(sender, message) {
    if (typeof sender.tab?.id !== "number") {
        return {
            ok: false,
            error: "Sender tab id is missing."
        };
    }

    const existingMetadata = await getAutomationTabMetadata(sender.tab.id);
    const urlLaunchContext = parseLaunchContext(sender.tab.url || "");
    const bridgeBaseUrl = normalizeBridgeBaseUrl(message?.bridgeBaseUrl) || existingMetadata?.bridgeBaseUrl || urlLaunchContext?.bridgeBaseUrl;
    const claimToken = normalizeNullableString(message?.claimToken) || existingMetadata?.claimToken || urlLaunchContext?.claimToken;
    const sessionId = normalizeNullableString(message?.sessionId) || existingMetadata?.sessionId || urlLaunchContext?.sessionId;
    const isTemporary = typeof message?.isTemporary === "boolean" ? message.isTemporary : existingMetadata?.isTemporary ?? urlLaunchContext?.isTemporary ?? false;

    if (!bridgeBaseUrl) {
        logBackground("warn", "Claim failed because bridge base URL is missing.", {
            tabId: sender.tab.id,
            senderUrl: sender.tab.url
        });
        return {
            ok: false,
            error: "Bridge base URL is missing."
        };
    }

    const metadata = {
        ...(existingMetadata || {}),
        bridgeBaseUrl,
        claimToken,
        sessionId,
        isTemporary,
        launchPending: false
    };

    await setAutomationTabMetadata(sender.tab.id, metadata);
    await setLastAutomationTabId(sender.tab.id);
    logBackground("info", "Automation tab claimed.", {
        tabId: sender.tab.id,
        bridgeBaseUrl,
        sessionId,
        isTemporary
    });
    await emitBridgeLog(bridgeBaseUrl, "background", "info", "Automation tab claimed.", {
        tabId: sender.tab.id,
        sessionId,
        isTemporary,
        claimToken
    });
    return {
        ok: true,
        tabId: sender.tab.id,
        bridgeBaseUrl,
        claimToken,
        sessionId
    };
}

async function getBridgeContext(sender) {
    const metadata = await getSenderAutomationTabMetadata(sender);
    return {
        bridgeContext: metadata
    };
}

async function isSenderActiveTab(sender) {
    if (typeof sender.tab?.id !== "number") {
        return {
            isActiveTab: false
        };
    }

    const tab = await browser.tabs.get(sender.tab.id);
    return {
        isActiveTab: Boolean(tab.active)
    };
}

async function getSenderAutomationTabMetadata(sender) {
    if (typeof sender.tab?.id !== "number") {
        return null;
    }

    return getAutomationTabMetadata(sender.tab.id);
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

async function setAutomationTabMetadata(tabId, metadata) {
    const automationTabs = await getAutomationTabs();
    automationTabs[String(tabId)] = {
        bridgeBaseUrl: normalizeBridgeBaseUrl(metadata.bridgeBaseUrl),
        claimToken: normalizeNullableString(metadata.claimToken),
        sessionId: normalizeNullableString(metadata.sessionId),
        isTemporary: Boolean(metadata.isTemporary),
        launchPending: Boolean(metadata.launchPending),
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

async function proxyBridgeRequest(message, sender) {
    if (typeof message.path !== "string" || !message.path.startsWith("/")) {
        return {
            ok: false,
            status: 0,
            statusText: "INVALID_PATH",
            error: "Bridge path must start with '/'.",
            body: null
        };
    }

    const senderMetadata = await getSenderAutomationTabMetadata(sender);
    const bridgeBaseUrl = normalizeBridgeBaseUrl(message?.bridgeBaseUrl) || senderMetadata?.bridgeBaseUrl;
    await appendDebugLog("background", "debug", "bridgeRequest received.", {
        path: message.path,
        senderTabId: sender?.tab?.id || null,
        senderUrl: sender?.tab?.url || null,
        hasBoundBridge: Boolean(bridgeBaseUrl)
    });
    if (!bridgeBaseUrl) {
        logBackground("warn", "bridgeRequest failed because no bridge is bound to the tab.", {
            path: message.path,
            senderTabId: sender?.tab?.id || null,
            senderUrl: sender?.tab?.url || null,
            senderMetadata: senderMetadata || null
        });
        return {
            ok: false,
            status: 0,
            statusText: "UNBOUND_BRIDGE",
            error: "Bridge base URL is not bound to this tab.",
            body: null
        };
    }

    const init = message.init && typeof message.init === "object" ? message.init : {};
    const headers = new Headers(init.headers || {});
    if (!headers.has("Content-Type") && typeof init.body === "string") {
        headers.set("Content-Type", "application/json");
    }

    try {
        const response = await fetch(`${bridgeBaseUrl}${message.path}`, {
            method: init.method || "GET",
            headers,
            body: init.body,
            cache: "no-store"
        });

        const contentType = response.headers.get("content-type") || "";
        const text = response.status === 204 ? "" : await response.text();
        let body = null;

        if (text) {
            if (contentType.includes("application/json")) {
                try {
                    body = JSON.parse(text);
                } catch (error) {
                    logBackground("warn", "Failed to parse JSON from bridge.", {
                        path: message.path,
                        error: error instanceof Error ? error.message : String(error)
                    });
                    body = text;
                }
            } else {
                body = text;
            }
        }

        return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            error: null,
            body
        };
    } catch (error) {
        logBackground("error", "Proxy bridge request failed.", {
            path: message.path,
            bridgeBaseUrl,
            error: error instanceof Error ? error.message : String(error)
        });
        await emitBridgeLog(bridgeBaseUrl, "background", "error", "Proxy bridge request failed.", {
            path: message.path,
            error: error instanceof Error ? error.message : String(error)
        });
        return {
            ok: false,
            status: 0,
            statusText: "FETCH_ERROR",
            error: error instanceof Error ? error.message : String(error),
            body: null
        };
    }
}

async function ensureNativeBridgeHost(reason) {
    if (nativeBridgeState.status === "ready" && nativeBridgeState.connected) {
        return { ...nativeBridgeState };
    }

    if (nativeHostConnectPromise) {
        return await nativeHostConnectPromise;
    }

    nativeHostConnectPromise = (async () => {
        try {
            if (!nativeHostPort) {
                attachNativeHostPort(browser.runtime.connectNative(NATIVE_HOST_NAME));
            }

            postToNativeHost({
                type: "ensureBridge",
                bridgeHost: DEFAULT_NATIVE_BRIDGE_HOST,
                bridgePort: DEFAULT_NATIVE_BRIDGE_PORT,
                sessionId: DEFAULT_NATIVE_BRIDGE_SESSION_ID
            });
            await waitForNativeBridgeReady(NATIVE_BRIDGE_READY_TIMEOUT_MS);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            nativeBridgeState.lastError = message;
            logBackground("warn", "Failed to initialize the native bridge host.", {
                reason,
                error: message,
                hostName: NATIVE_HOST_NAME,
                installHint: "Run `npm run install:firefox-host` and reload the extension."
            });
        } finally {
            nativeHostConnectPromise = null;
        }

        return { ...nativeBridgeState };
    })();

    return await nativeHostConnectPromise;
}

function attachNativeHostPort(port) {
    nativeHostPort = port;
    nativeBridgeState.connected = true;
    nativeBridgeState.lastError = null;

    port.onMessage.addListener((message) => {
        handleNativeHostMessage(message).catch((error) => {
            logBackground("warn", "Failed to handle a native host message.", {
                error: error instanceof Error ? error.message : String(error)
            });
        });
    });

    port.onDisconnect.addListener(() => {
        const disconnectError = browser.runtime.lastError?.message || null;
        nativeHostPort = null;
        nativeBridgeState = {
            ...nativeBridgeState,
            connected: false,
            lastError: disconnectError,
            status: disconnectError ? "error" : "stopped"
        };
        logBackground(disconnectError ? "warn" : "info", "Native bridge host disconnected.", {
            error: disconnectError,
            hostName: NATIVE_HOST_NAME
        });
    });
}

function postToNativeHost(message) {
    if (!nativeHostPort) {
        throw new Error("Native bridge host is not connected.");
    }

    nativeHostPort.postMessage(message);
}

async function handleNativeHostMessage(message) {
    if (message?.type === "host-ready") {
        await appendDebugLog("native-host", "info", "Native bridge host connected.", {
            pid: message.pid || null,
            bridgeEntryPath: message.bridgeEntryPath || null
        });
        return;
    }

    if (message?.type === "bridge-status") {
        nativeBridgeState = {
            ...nativeBridgeState,
            status: normalizeNullableString(message.status) || nativeBridgeState.status,
            baseUrl: normalizeBridgeBaseUrl(message.baseUrl),
            sessionId: normalizeNullableString(message.sessionId),
            detail: normalizeNullableString(message.detail),
            pid: typeof message.pid === "number" ? message.pid : null,
            source: normalizeNullableString(message.source) || "none",
            connected: true,
            lastError: message.status === "error" ? normalizeNullableString(message.detail) : null
        };

        await appendDebugLog("native-host", message.status === "error" ? "error" : "info", "Native bridge host status changed.", {
            status: nativeBridgeState.status,
            baseUrl: nativeBridgeState.baseUrl,
            pid: nativeBridgeState.pid,
            detail: nativeBridgeState.detail,
            source: nativeBridgeState.source
        });
        return;
    }

    if (message?.type === "bridge-log") {
        const line = normalizeNullableString(message.line);
        if (!line) {
            return;
        }

        await appendDebugLog("native-host", parseNativeHostLogLevel(line), line, {
            stream: normalizeNullableString(message.stream) || "stderr"
        });
    }
}

async function waitForNativeBridgeReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (nativeBridgeState.status === "ready" && nativeBridgeState.baseUrl) {
            return nativeBridgeState;
        }

        if (nativeBridgeState.status === "error") {
            throw new Error(nativeBridgeState.detail || "Native bridge host reported an error.");
        }

        await sleep(100);
    }

    throw new Error("Timed out while waiting for the native bridge host to start the local bridge.");
}

function parseLaunchContext(urlString) {
    try {
        const url = new URL(urlString);
        if (!url.href.startsWith("https://chatgpt.com/")) {
            return null;
        }

        const claimToken = normalizeNullableString(readLaunchParam(url, BRIDGE_CLAIM_QUERY_PARAM));
        const bridgePort = normalizeBridgePort(readLaunchParam(url, BRIDGE_PORT_QUERY_PARAM));
        if (!claimToken || !bridgePort) {
            return null;
        }

        return {
            bridgeBaseUrl: `http://127.0.0.1:${bridgePort}`,
            claimToken,
            sessionId: normalizeNullableString(readLaunchParam(url, BRIDGE_SESSION_QUERY_PARAM)),
            isTemporary: parseBridgeBoolean(readLaunchParam(url, BRIDGE_TEMPORARY_QUERY_PARAM))
        };
    } catch (error) {
        logBackground("warn", "Failed to parse launch context.", {
            urlString,
            error: error instanceof Error ? error.message : String(error)
        });
        return null;
    }
}

function readLaunchParam(url, key) {
    const queryValue = url.searchParams.get(key);
    if (queryValue) {
        return queryValue;
    }

    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    if (!hash) {
        return null;
    }

    return new URLSearchParams(hash).get(key);
}

function normalizeBridgeBaseUrl(value) {
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    try {
        const url = new URL(trimmed);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
            return null;
        }

        return `${url.protocol}//${url.hostname}:${url.port}`;
    } catch {
        return null;
    }
}

function normalizeBridgePort(value) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!/^\d+$/.test(text)) {
        return null;
    }

    const port = Number.parseInt(text, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return null;
    }

    return port;
}

function normalizeNullableString(value) {
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();
    return trimmed || null;
}

function parseBridgeBoolean(value) {
    if (value === null || value === undefined) {
        return false;
    }

    return !/^(0|false|no|off)$/i.test(`${value}`.trim());
}

function parseNativeHostLogLevel(line) {
    const normalizedLine = `${line || ""}`.toLowerCase();
    if (normalizedLine.includes("[error]")) {
        return "error";
    }

    if (normalizedLine.includes("[warn]")) {
        return "warn";
    }

    if (normalizedLine.includes("[debug]")) {
        return "debug";
    }

    return "info";
}

function resolveLaunchPending(existingMetadata, launchContext) {
    if (!existingMetadata) {
        return true;
    }

    const isSameLaunch =
        normalizeNullableString(existingMetadata.claimToken) === normalizeNullableString(launchContext.claimToken) &&
        normalizeNullableString(existingMetadata.sessionId) === normalizeNullableString(launchContext.sessionId) &&
        normalizeBridgeBaseUrl(existingMetadata.bridgeBaseUrl) === normalizeBridgeBaseUrl(launchContext.bridgeBaseUrl);

    if (isSameLaunch && existingMetadata.launchPending === false) {
        return false;
    }

    return true;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function emitBridgeLog(bridgeBaseUrl, source, level, message, context) {
    const normalizedBridgeBaseUrl = normalizeBridgeBaseUrl(bridgeBaseUrl);
    if (!normalizedBridgeBaseUrl) {
        return;
    }

    try {
        await fetch(`${normalizedBridgeBaseUrl}/logs/client`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                source,
                level,
                message,
                context
            }),
            cache: "no-store"
        });
    } catch (error) {
        logBackground("warn", "Failed to send diagnostic log to bridge.", {
            bridgeBaseUrl: normalizedBridgeBaseUrl,
            message,
            error: error instanceof Error ? error.message : String(error)
        });
    }
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

    const nextLogs = currentLogs.slice(-DEBUG_LOG_LIMIT);
    await browser.storage.local.set({ [DEBUG_LOGS_KEY]: nextLogs });
    return { ok: true };
}

function logBackground(level, message, context) {
    const consoleMethod =
        level === "error" ? console.error :
            level === "warn" ? console.warn :
                level === "debug" ? console.debug :
                    console.info;
    consoleMethod(`[chatgpt-web-bridge/background] ${message}`, context);
    void appendDebugLog("background", level, message, context);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
