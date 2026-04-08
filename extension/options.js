const form = document.querySelector("#settings-form");
const serverUrlInput = document.querySelector("#server-url");
const serverAccessTokenInput = document.querySelector("#server-access-token");
const userTokenInput = document.querySelector("#user-token");
const statusNode = document.querySelector("#status");

void initialize();

async function initialize() {
    const config = await browser.runtime.sendMessage({
        type: "loadAgentConfig"
    });
    if (config) {
        serverUrlInput.value = config.serverUrl || "";
        serverAccessTokenInput.value = config.serverAccessToken || "";
        userTokenInput.value = config.userToken || "";
    }

    await refreshStatus();
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        await browser.runtime.sendMessage({
            type: "saveAgentConfig",
            config: {
                serverUrl: serverUrlInput.value,
                serverAccessToken: serverAccessTokenInput.value,
                userToken: userTokenInput.value
            }
        });
        await refreshStatus();
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
