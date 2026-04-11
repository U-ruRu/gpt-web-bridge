const form = document.querySelector("#settings-form");
const serverUrlInput = document.querySelector("#server-url");
const serverAccessTokenInput = document.querySelector("#server-access-token");
const userTokenInput = document.querySelector("#user-token");
const parallelChatsModeInput = document.querySelector("#parallel-chats-mode");
const typingSpeedMultiplierInput = document.querySelector("#typing-speed-multiplier");
const temporaryModeDelaySecondsInput = document.querySelector("#temporary-mode-delay-seconds");
const statusNode = document.querySelector("#status");
const STATUS_REFRESH_INTERVAL_MS = 1000;

let statusRefreshTimer = null;

void initialize();

async function initialize() {
    const config = await browser.runtime.sendMessage({
        type: "loadAgentConfig"
    });
    if (config) {
        serverUrlInput.value = config.serverUrl || "";
        serverAccessTokenInput.value = config.serverAccessToken || "";
        userTokenInput.value = config.userToken || "";
        parallelChatsModeInput.value = config.parallelChatsMode || "sequential_safe_timeout";
        typingSpeedMultiplierInput.value = `${config.typingSpeedMultiplier || 4}`;
        temporaryModeDelaySecondsInput.value = `${config.temporaryModeDelaySeconds ?? 5}`;
    }

    await refreshStatus();
    startStatusAutoRefresh();
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        await browser.runtime.sendMessage({
            type: "saveAgentConfig",
            config: {
                serverUrl: serverUrlInput.value,
                serverAccessToken: serverAccessTokenInput.value,
                userToken: userTokenInput.value,
                parallelChatsMode: parallelChatsModeInput.value,
                typingSpeedMultiplier: typingSpeedMultiplierInput.value,
                temporaryModeDelaySeconds: temporaryModeDelaySecondsInput.value
            }
        });
        await refreshStatus();
    });
    window.addEventListener("focus", () => {
        void refreshStatus();
    });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            void refreshStatus();
        }
    });
}

async function refreshStatus() {
    const status = await browser.runtime.sendMessage({
        type: "getAgentStatus"
    });
    statusNode.textContent = [
        `status: ${status?.status || "unknown"}`,
        `detail: ${status?.detail || "-"}`,
        `server: ${status?.serverUrl || "-"}`,
        `agentId: ${status?.agentId || "-"}`,
        `userId: ${status?.userId || "-"}`,
        `configured: ${status?.hasConfiguration ? "yes" : "no"}`
    ].join("\n");
}

function startStatusAutoRefresh() {
    if (statusRefreshTimer) {
        return;
    }

    statusRefreshTimer = setInterval(() => {
        void refreshStatus();
    }, STATUS_REFRESH_INTERVAL_MS);
}
