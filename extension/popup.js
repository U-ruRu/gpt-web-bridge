const openChatButton = document.querySelector("#open-chat");
const openSettingsButton = document.querySelector("#open-settings");
const statusNode = document.querySelector("#status");

void initialize();

async function initialize() {
    await refreshStatus();

    openChatButton.addEventListener("click", async () => {
        openChatButton.disabled = true;
        try {
            await browser.runtime.sendMessage({
                type: "openAutomationWorkspace"
            });
            window.close();
        } finally {
            openChatButton.disabled = false;
        }
    });

    openSettingsButton.addEventListener("click", async () => {
        openSettingsButton.disabled = true;
        try {
            await browser.runtime.sendMessage({
                type: "openSettingsPage"
            });
            window.close();
        } finally {
            openSettingsButton.disabled = false;
        }
    });
}

async function refreshStatus() {
    const status = await browser.runtime.sendMessage({
        type: "getAgentStatus"
    });
    statusNode.textContent = [
        `status: ${status?.status || "unknown"}`,
        `server: ${status?.serverUrl || "-"}`,
        `configured: ${status?.hasConfiguration ? "yes" : "no"}`
    ].join("\n");
}
