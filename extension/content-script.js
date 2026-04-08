(function () {
    const CHATGPT_HOME_URL = "https://chatgpt.com/";
    const BRIDGE_CLAIM_QUERY_PARAM = "bridgeClaim";
    const BRIDGE_PORT_QUERY_PARAM = "bridgePort";
    const BRIDGE_SESSION_QUERY_PARAM = "bridgeSessionId";
    const BRIDGE_TEMPORARY_QUERY_PARAM = "bridgeTemporary";
    const TEMPORARY_CHAT_QUERY_PARAM = "temporary-chat";
    const POLL_DELAY_MS = 2000;
    const SHORT_DELAY_MS = 250;
    const DEFAULT_WAIT_MS = 12000;
    const SEND_TIMEOUT_MS = 8000;
    const RESPONSE_TIMEOUT_MS = 180000;
    const RESPONSE_STABLE_MS = 1800;
    const SESSION_URL_REGEX = /^https:\/\/chatgpt\.com\/c\/[^/?#]+/;
    const TYPING_DELAY_MIN_MS = 45;
    const TYPING_DELAY_MAX_MS = 170;
    const TYPING_DELAY_SPACE_BONUS_MS = 90;
    const TYPING_DELAY_PUNCTUATION_BONUS_MS = 140;
    const PRE_SUBMIT_DELAY_MS = 1000;
    const PRE_SUBMIT_JITTER_MIN_MS = 180;
    const PRE_SUBMIT_JITTER_MAX_MS = 900;

    let loopStarted = false;
    let currentJobId = null;
    let currentAutomationCommandToken = null;
    let lastLoopStateSignature = null;

    handleBridgeLaunchParams().catch((error) => {
        console.error("[chatgpt-web-bridge] Failed to process launch params.", error);
        void emitDiagnosticLog("error", "Failed to process launch params.", {
            error: error instanceof Error ? error.message : String(error)
        });
    });

    startLoop().catch((error) => {
        console.error("[chatgpt-web-bridge] Failed to start content loop.", error);
        void emitDiagnosticLog("error", "Failed to start content loop.", {
            error: error instanceof Error ? error.message : String(error)
        });
    });

    async function startLoop() {
        if (loopStarted) {
            return;
        }

        loopStarted = true;
        console.info("[chatgpt-web-bridge] Content loop started.");
        await emitDiagnosticLog("info", "Content loop started.", {
            url: location.href
        });

        while (true) {
            try {
                const isAutomationTab = await isDedicatedAutomationTab();
                if (!isAutomationTab.isAutomationTab) {
                    await recordLoopState("waiting-for-automation-tab", {
                        url: location.href,
                        bridgeContext: isAutomationTab.metadata || null
                    });
                    await sleep(POLL_DELAY_MS);
                    continue;
                }

                if (!currentJobId && !currentAutomationCommandToken) {
                    const command = await getPendingAutomationCommand();
                    if (command) {
                        console.info("[chatgpt-web-bridge] Received automation command.", command.token, command.type);
                        currentAutomationCommandToken = command.token;
                        await executeAutomationCommand(command);
                        continue;
                    }
                }

                const activeSession = await getActiveSession();
                if (!activeSession) {
                    await recordLoopState("waiting-for-active-session", {
                        url: location.href
                    });
                    await sleep(POLL_DELAY_MS);
                    continue;
                }

                if (!ensureCorrectPage(activeSession)) {
                    await recordLoopState("waiting-for-correct-page", {
                        url: location.href,
                        targetUrl: activeSession.targetUrl,
                        freshChatRequired: activeSession.freshChatRequired
                    });
                    console.info("[chatgpt-web-bridge] Waiting for the automation tab to reach the correct page.");
                    await sleep(POLL_DELAY_MS);
                    continue;
                }

                if (currentJobId) {
                    await recordLoopState("job-in-progress", {
                        jobId: currentJobId,
                        url: location.href
                    });
                    await sleep(POLL_DELAY_MS);
                    continue;
                }

                const job = await getNextJob(activeSession.sessionId);
                if (!job) {
                    await recordLoopState("waiting-for-job", {
                        sessionId: activeSession.sessionId,
                        url: location.href
                    });
                    await sleep(POLL_DELAY_MS);
                    continue;
                }

                await recordLoopState("job-received", {
                    sessionId: activeSession.sessionId,
                    jobId: job.id,
                    textLength: job.text?.length || 0
                });
                console.info("[chatgpt-web-bridge] Received job.", job.id, activeSession.sessionId);
                currentJobId = job.id;
                await executeJob(job, activeSession);
            } catch (error) {
                console.error("[chatgpt-web-bridge] Polling loop error.", error);
                await emitDiagnosticLog("error", "Polling loop error.", {
                    error: error instanceof Error ? error.message : String(error),
                    url: location.href
                });
                await sleep(POLL_DELAY_MS);
            }
        }
    }

    async function executeAutomationCommand(command) {
        try {
            console.info("[chatgpt-web-bridge] Starting automation command.", command.token, command.type);
            await emitDiagnosticLog("info", "Starting automation command.", {
                token: command.token,
                type: command.type
            });
            await updateAutomationCommand(command.token, "running", "Automation command is being processed.");

            if (command.type === "set-temporary") {
                await executeSetTemporaryCommand(command.token);
                return;
            }

            throw new Error(`Unsupported automation command: ${command.type}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            try {
                await updateAutomationCommand(command.token, "failed", message);
            } catch (reportError) {
                console.warn("[chatgpt-web-bridge] Failed to report automation command failure.", reportError);
            }

            console.error("[chatgpt-web-bridge] Automation command failed.", command.token, message);
            await emitDiagnosticLog("error", "Automation command failed.", {
                token: command.token,
                type: command.type,
                error: message
            });
        } finally {
            currentAutomationCommandToken = null;
            await sleep(POLL_DELAY_MS);
        }
    }

    async function executeSetTemporaryCommand(token) {
        if (!isChatHome(location.href)) {
            console.info("[chatgpt-web-bridge] Redirecting to a fresh chat before enabling temporary mode.", location.href);
            await emitDiagnosticLog("info", "Redirecting to a fresh chat before enabling temporary mode.", {
                url: location.href
            });
            location.href = CHATGPT_HOME_URL;
            return;
        }

        const composer = await waitForComposer(DEFAULT_WAIT_MS);
        if (!composer) {
            throw new Error("Composer was not found on the open chat page.");
        }

        const enabled = await ensureTemporaryChatMode(DEFAULT_WAIT_MS);
        if (!enabled) {
            throw new Error("Temporary chat mode could not be enabled.");
        }

        const composerAfterSwitch = await waitForComposer(DEFAULT_WAIT_MS);
        if (!composerAfterSwitch) {
            throw new Error("Composer did not become ready after temporary chat was enabled.");
        }

        await updateAutomationCommand(token, "completed", "Temporary chat mode is enabled.");
        console.info("[chatgpt-web-bridge] Automation command completed.", token, "set-temporary");
        await emitDiagnosticLog("info", "Automation command completed.", {
            token,
            type: "set-temporary",
            url: location.href
        });
    }

    async function executeJob(job, activeSession) {
        try {
            console.info("[chatgpt-web-bridge] Starting job execution.", job.id);
            await emitDiagnosticLog("info", "Starting job execution.", {
                jobId: job.id,
                sessionId: activeSession.sessionId,
                targetUrl: activeSession.targetUrl,
                url: location.href
            });
            await updateJobStatus(job.id, {
                status: "running",
                detail: "Content script started processing the job."
            });

            const composer = await waitForComposer(DEFAULT_WAIT_MS);
            if (!composer) {
                throw new Error("Composer was not found on the page.");
            }

            clearComposer(composer);
            const inserted = await insertPromptText(composer, job.text);
            if (!inserted) {
                throw new Error("Failed to insert text into the ChatGPT composer.");
            }

            const previousAssistantSnapshot = getLatestAssistantMessageSnapshot();
            await sleep(getPreSubmitDelay());
            const submitted = await submitPrompt(composer);
            if (!submitted) {
                throw new Error("Send button did not become available.");
            }

            const sent = await waitForSendFeedback(composer);
            if (!sent) {
                throw new Error("ChatGPT did not acknowledge the send action in time.");
            }

            const conversationUrl =
                (await waitForConversationUrl(5000)) ||
                extractConversationUrl(location.href) ||
                activeSession.conversationUrl ||
                undefined;

            const assistantResponse = await waitForAssistantResponse(previousAssistantSnapshot, RESPONSE_TIMEOUT_MS);
            if (!assistantResponse?.text) {
                throw new Error("Assistant response was not captured in time.");
            }

            await updateJobStatus(job.id, {
                status: "sent",
                detail: "Prompt was submitted and the assistant response was captured.",
                conversationUrl,
                responseText: assistantResponse.text
            });
            console.info(
                "[chatgpt-web-bridge] Job completed.",
                job.id,
                conversationUrl || "no-conversation-url",
                `response-length=${assistantResponse.text.length}`
            );
            await emitDiagnosticLog("info", "Job completed.", {
                jobId: job.id,
                conversationUrl: conversationUrl || null,
                responseLength: assistantResponse.text.length,
                url: location.href
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await updateJobStatus(job.id, {
                status: "failed",
                detail: message,
                conversationUrl: extractConversationUrl(location.href) || undefined
            });
            console.error("[chatgpt-web-bridge] Job failed.", job.id, message);
            await emitDiagnosticLog("error", "Job failed.", {
                jobId: job.id,
                error: message,
                url: location.href
            });
        } finally {
            currentJobId = null;
            await sleep(POLL_DELAY_MS);
        }
    }

    async function isDedicatedAutomationTab() {
        const result = await browser.runtime.sendMessage({ type: "isAutomationTab" });
        return {
            isAutomationTab: Boolean(result?.isAutomationTab),
            metadata: result?.metadata || null
        };
    }

    async function getActiveSession() {
        const response = await bridgeRequest("/session/active");
        if (response.status === 204) {
            return null;
        }

        if (!response.ok) {
            throw new Error(`Failed to fetch active session: ${response.status}`);
        }

        return response.body;
    }

    async function getNextJob(sessionId) {
        const response = await bridgeRequest(`/session/next?sessionId=${encodeURIComponent(sessionId)}`);
        if (response.status === 204) {
            return null;
        }

        if (!response.ok) {
            throw new Error(`Failed to fetch next job: ${response.status}`);
        }

        return response.body;
    }

    async function getPendingAutomationCommand() {
        const response = await bridgeRequest("/automation/command");
        if (response.status === 204) {
            return null;
        }

        if (!response.ok) {
            throw new Error(`Failed to fetch automation command: ${response.status}`);
        }

        return response.body;
    }

    async function updateJobStatus(jobId, payload) {
        const response = await bridgeRequest(`/jobs/${encodeURIComponent(jobId)}/status`, {
            method: "POST",
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.warn("[chatgpt-web-bridge] Failed to update job status.", jobId, response.status);
        }
    }

    async function updateAutomationCommand(token, status, detail) {
        const response = await bridgeRequest("/automation/command/status", {
            method: "POST",
            body: JSON.stringify({ token, status, detail })
        });

        if (!response.ok) {
            throw new Error(`Failed to update automation command: ${response.status}`);
        }

        return response.body;
    }

    async function bridgeRequest(path, init = {}) {
        const message = {
            type: "bridgeRequest",
            path,
            init: {
                method: init.method || "GET",
                body: typeof init.body === "string" ? init.body : undefined,
                headers: init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined
            }
        };

        const response = await browser.runtime.sendMessage(message);
        if (!response) {
            throw new Error("Extension background did not respond.");
        }

        if (response.status === 0) {
            throw new Error(`Bridge request failed: ${response.error || "Unknown error"}`);
        }

        return response;
    }

    async function emitDiagnosticLog(level, message, context = {}) {
        try {
            await browser.runtime.sendMessage({
                type: "debugLog",
                source: "content-script",
                level,
                message,
                context
            });
        } catch (error) {
            console.warn("[chatgpt-web-bridge] Failed to store local diagnostic log.", {
                level,
                message,
                error: error instanceof Error ? error.message : String(error)
            });
        }

        try {
            const bridgeContextResult = await browser.runtime.sendMessage({ type: "getBridgeContext" });
            const bridgeContext = bridgeContextResult?.bridgeContext;
            if (!bridgeContext?.bridgeBaseUrl) {
                return;
            }

            await bridgeRequest("/logs/client", {
                method: "POST",
                body: JSON.stringify({
                    source: "content-script",
                    level,
                    message,
                    context
                })
            });
        } catch (error) {
            console.warn("[chatgpt-web-bridge] Failed to send diagnostic log to bridge.", {
                level,
                message,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    async function recordLoopState(state, context = {}) {
        const signature = `${state}|${JSON.stringify(context)}`;
        if (signature === lastLoopStateSignature) {
            return;
        }

        lastLoopStateSignature = signature;
        await emitDiagnosticLog("debug", `Loop state: ${state}`, context);
    }

    async function handleBridgeLaunchParams() {
        const launch = await getPendingLaunchContext();
        if (!launch) {
            try {
                await browser.runtime.sendMessage({
                    type: "debugLog",
                    source: "content-script",
                    level: "debug",
                    message: "No pending launch context was found on page load.",
                    context: {
                        url: location.href
                    }
                });
            } catch (error) {
                console.warn("[chatgpt-web-bridge] Failed to store launch-context diagnostic log.", error);
            }
            return;
        }

        try {
            const claimResult = await browser.runtime.sendMessage({
                type: "claimAutomationTab",
                bridgeBaseUrl: launch.bridgeBaseUrl,
                claimToken: launch.token,
                sessionId: launch.sessionId || undefined,
                isTemporary: launch.isTemporary
            });
            if (!claimResult?.ok) {
                throw new Error(claimResult?.error || "Failed to claim the automation tab.");
            }

            await emitDiagnosticLog("info", "Automation tab claimed from launch params.", {
                token: launch.token,
                sessionId: launch.sessionId,
                isTemporary: launch.isTemporary,
                bridgeBaseUrl: launch.bridgeBaseUrl,
                fromUrlParams: launch.fromUrlParams,
                url: location.href
            });

            await updateAutomationLaunch(launch.token, "claimed", "Automation tab claimed.");
            const composer = await waitForComposer(DEFAULT_WAIT_MS);
            if (!composer) {
                throw new Error("Composer was not found on the fresh chat page.");
            }

            if (launch.isTemporary) {
                const enabled = await ensureTemporaryChatMode(DEFAULT_WAIT_MS);
                if (!enabled) {
                    throw new Error("Temporary chat mode could not be enabled.");
                }
            }

            await updateAutomationLaunch(
                launch.token,
                "ready",
                launch.isTemporary ? "Temporary chat is ready." : "Fresh chat is ready."
            );
            await emitDiagnosticLog("info", "Automation launch is ready.", {
                token: launch.token,
                isTemporary: launch.isTemporary,
                url: location.href
            });
            if (launch.fromUrlParams) {
                clearBridgeLaunchParams();
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            try {
                await updateAutomationLaunch(launch.token, "failed", message);
            } catch (reportError) {
                console.warn("[chatgpt-web-bridge] Failed to report launch failure.", reportError);
            }

            throw error;
        }
    }

    async function getPendingLaunchContext() {
        const params = getBridgeLaunchParams();
        if (params) {
            return {
                ...params,
                fromUrlParams: true
            };
        }

        const bridgeContextResult = await browser.runtime.sendMessage({ type: "getBridgeContext" });
        const bridgeContext = bridgeContextResult?.bridgeContext;
        if (!bridgeContext?.launchPending || !bridgeContext?.claimToken || !bridgeContext?.bridgeBaseUrl) {
            return null;
        }

        return {
            token: bridgeContext.claimToken,
            bridgeBaseUrl: bridgeContext.bridgeBaseUrl,
            sessionId: bridgeContext.sessionId || null,
            isTemporary: Boolean(bridgeContext.isTemporary),
            fromUrlParams: false
        };
    }

    function getBridgeLaunchParams() {
        const url = new URL(location.href);
        const token = readLaunchParam(url, BRIDGE_CLAIM_QUERY_PARAM);
        const bridgeBaseUrl = getBridgeBaseUrlFromUrl(url);
        if (!token || !bridgeBaseUrl) {
            return null;
        }

        return {
            token,
            bridgeBaseUrl,
            sessionId: normalizeNullableString(readLaunchParam(url, BRIDGE_SESSION_QUERY_PARAM)),
            isTemporary: parseBridgeBoolean(readLaunchParam(url, BRIDGE_TEMPORARY_QUERY_PARAM))
        };
    }

    function parseBridgeBoolean(value) {
        if (value === null) {
            return false;
        }

        return !/^(0|false|no|off)$/i.test(`${value}`.trim());
    }

    async function updateAutomationLaunch(token, status, detail) {
        const response = await bridgeRequest("/automation/claim", {
            method: "POST",
            body: JSON.stringify({ token, status, detail })
        });

        if (!response.ok) {
            throw new Error(`Failed to update automation launch: ${response.status}`);
        }

        return response.body;
    }

    function clearBridgeLaunchParams() {
        const url = new URL(location.href);
        url.searchParams.delete(BRIDGE_CLAIM_QUERY_PARAM);
        url.searchParams.delete(BRIDGE_PORT_QUERY_PARAM);
        url.searchParams.delete(BRIDGE_SESSION_QUERY_PARAM);
        url.searchParams.delete(BRIDGE_TEMPORARY_QUERY_PARAM);
        const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
        hashParams.delete(BRIDGE_CLAIM_QUERY_PARAM);
        hashParams.delete(BRIDGE_PORT_QUERY_PARAM);
        hashParams.delete(BRIDGE_SESSION_QUERY_PARAM);
        hashParams.delete(BRIDGE_TEMPORARY_QUERY_PARAM);
        url.hash = hashParams.toString();
        history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }

    function ensureCorrectPage(activeSession) {
        const targetUrl = activeSession.targetUrl || CHATGPT_HOME_URL;
        if (activeSession.freshChatRequired) {
            if (!isChatHome(location.href)) {
                console.info("[chatgpt-web-bridge] Redirecting automation tab to a fresh chat.", location.href);
                location.href = CHATGPT_HOME_URL;
                return false;
            }

            return true;
        }

        if (!location.href.startsWith(targetUrl)) {
            console.info("[chatgpt-web-bridge] Redirecting automation tab to an existing conversation.", targetUrl);
            location.href = targetUrl;
            return false;
        }

        return true;
    }

    function isChatHome(url) {
        try {
            const parsedUrl = new URL(url, CHATGPT_HOME_URL);
            return parsedUrl.origin === "https://chatgpt.com" && isChatHomePath(parsedUrl.pathname);
        } catch (error) {
            console.warn("[chatgpt-web-bridge] Failed to parse chat home URL.", url, error);
            return url === CHATGPT_HOME_URL || url === "https://chatgpt.com";
        }
    }

    function isChatHomePath(pathname) {
        const normalizedPath = `${pathname || "/"}`.replace(/\/+$/, "") || "/";
        if (normalizedPath === "/") {
            return true;
        }

        const segments = normalizedPath.split("/").filter(Boolean);
        return segments.length === 1 && /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(segments[0]);
    }

    async function waitForComposer(timeoutMs) {
        return waitFor(() => {
            const maybeLoginButton = document.querySelector("button[data-testid='login-button']");
            if (maybeLoginButton) {
                throw new Error("The automation tab is not logged into ChatGPT.");
            }

            return document.querySelector("#prompt-textarea.ProseMirror[contenteditable='true']");
        }, timeoutMs);
    }

    function clearComposer(composer) {
        composer.focus();
        selectComposerContents(composer);

        document.execCommand("delete", false);
        setComposerTextFallback(composer, "");
        placeCaretAtEnd(composer);
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    }

    async function insertPromptText(composer, text) {
        for (const char of text) {
            const inserted = insertCharacter(composer, char);
            if (!inserted) {
                return false;
            }

            await sleep(getTypingDelay(char));
        }

        composer.dispatchEvent(new Event("change", { bubbles: true }));
        const actualText = normalizeComposerText(getComposerText(composer));
        const expectedText = normalizeComposerText(text);
        const matches = actualText === expectedText;
        if (!matches) {
            console.warn("[chatgpt-web-bridge] Composer text mismatch after typing.", {
                expectedText,
                actualText,
                composerHtml: composer.innerHTML
            });
        }

        return matches;
    }

    async function submitPrompt(composer) {
        const sendButton = await waitFor(findSendButton, 3000);
        if (sendButton) {
            sendButton.click();
            return true;
        }

        return triggerEnterFallback(composer);
    }

    function findSendButton() {
        const form = document.querySelector("form");
        if (!form) {
            return null;
        }

        const explicit = form.querySelector(
            "button[data-testid='send-button'], button[aria-label*='Отправ'], button[aria-label*='Send'], button[aria-label*='Submit']"
        );
        if (isEnabledSubmitCandidate(explicit)) {
            return explicit;
        }

        const submitStyled = form.querySelector("button.composer-submit-button-color");
        if (!isEnabledSubmitCandidate(submitStyled)) {
            return null;
        }

        const label = `${submitStyled.getAttribute("aria-label") || ""}`.toLowerCase();
        const isVoice = label.includes("голос") || label.includes("voice");
        return isVoice ? null : submitStyled;
    }

    function isEnabledSubmitCandidate(button) {
        if (!(button instanceof HTMLButtonElement)) {
            return false;
        }

        if (button.disabled) {
            return false;
        }

        const style = window.getComputedStyle(button);
        if (style.display === "none" || style.visibility === "hidden") {
            return false;
        }

        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function triggerEnterFallback(composer) {
        const eventOptions = {
            bubbles: true,
            cancelable: true,
            key: "Enter",
            code: "Enter",
            which: 13,
            keyCode: 13
        };

        composer.dispatchEvent(new KeyboardEvent("keydown", eventOptions));
        composer.dispatchEvent(new KeyboardEvent("keypress", eventOptions));
        composer.dispatchEvent(new KeyboardEvent("keyup", eventOptions));
        return true;
    }

    async function waitForSendFeedback(composer) {
        const started = await waitFor(() => {
            if (!getComposerText(composer).trim()) {
                return true;
            }

            return findGenerationStopButton();
        }, SEND_TIMEOUT_MS);

        return Boolean(started);
    }

    async function waitForConversationUrl(timeoutMs) {
        const matchedUrl = await waitFor(() => extractConversationUrl(location.href), timeoutMs);
        return matchedUrl || null;
    }

    function extractConversationUrl(currentUrl) {
        const match = currentUrl.match(SESSION_URL_REGEX);
        return match ? match[0] : null;
    }

    function getComposerText(composer) {
        return composer.textContent || "";
    }

    async function ensureTemporaryChatMode(timeoutMs) {
        if (isTemporaryChatEnabled()) {
            console.info("[chatgpt-web-bridge] Temporary chat is already enabled.", location.href);
            return true;
        }

        const button = await waitFor(findTemporaryChatEnableButton, timeoutMs);
        if (!(button instanceof HTMLButtonElement)) {
            console.warn("[chatgpt-web-bridge] Temporary chat toggle button was not found.");
            return false;
        }

        console.info("[chatgpt-web-bridge] Enabling temporary chat mode.");
        button.click();
        const enabled = await waitFor(() => (isTemporaryChatEnabled() ? true : null), timeoutMs);
        if (enabled) {
            console.info("[chatgpt-web-bridge] Temporary chat mode enabled.", location.href);
        }
        return Boolean(enabled);
    }

    function isTemporaryChatEnabled() {
        if (isTemporaryChatUrl()) {
            return true;
        }

        if (hasTemporaryChatHeading()) {
            return true;
        }

        return Boolean(
            document.querySelector(
                "button[aria-label='Выключить временный чат'], button[aria-label='Disable temporary chat'], button[aria-pressed='true'][aria-label*='временн'], button[aria-pressed='true'][aria-label*='temporary']"
            )
        );
    }

    function findTemporaryChatEnableButton() {
        return document.querySelector(
            "button[aria-label='Включить временный чат'], button[aria-label='Enable temporary chat'], button[aria-label*='временный чат'], button[aria-label*='temporary chat']"
        );
    }

    function isTemporaryChatUrl(url = location.href) {
        try {
            const parsedUrl = new URL(url, CHATGPT_HOME_URL);
            return parsedUrl.searchParams.get(TEMPORARY_CHAT_QUERY_PARAM) === "true";
        } catch (error) {
            console.warn("[chatgpt-web-bridge] Failed to parse temporary chat URL.", url, error);
            return false;
        }
    }

    function hasTemporaryChatHeading() {
        const headingCandidates = document.querySelectorAll("h1, h2, [role='heading']");
        for (const candidate of headingCandidates) {
            const text = normalizeVisibleText(candidate.textContent || "");
            if (text.includes("временный чат") || text.includes("temporary chat")) {
                return true;
            }
        }

        const bodyText = normalizeVisibleText(document.body?.innerText || "");
        return bodyText.includes("временный чат") || bodyText.includes("temporary chat");
    }

    function normalizeVisibleText(value) {
        return `${value}`.replace(/\s+/g, " ").trim().toLowerCase();
    }

    function getBridgeBaseUrlFromUrl(url) {
        const portValue = readLaunchParam(url, BRIDGE_PORT_QUERY_PARAM);
        if (!portValue || !/^\d+$/.test(portValue)) {
            return null;
        }

        const port = Number.parseInt(portValue, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return null;
        }

        return `http://127.0.0.1:${port}`;
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

    function normalizeNullableString(value) {
        if (typeof value !== "string") {
            return null;
        }

        const trimmed = value.trim();
        return trimmed || null;
    }

    async function waitForAssistantResponse(previousSnapshot, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        let latestSnapshot = null;
        let stableSince = 0;

        while (Date.now() < deadline) {
            const currentSnapshot = getLatestAssistantMessageSnapshot();
            const generationInProgress = Boolean(findGenerationStopButton());
            const hasNewAssistantContent = isNewAssistantSnapshot(previousSnapshot, currentSnapshot);

            if (hasNewAssistantContent) {
                if (
                    !latestSnapshot ||
                    latestSnapshot.key !== currentSnapshot.key ||
                    latestSnapshot.text !== currentSnapshot.text
                ) {
                    latestSnapshot = currentSnapshot;
                    stableSince = Date.now();
                } else if (!generationInProgress && latestSnapshot.text && Date.now() - stableSince >= RESPONSE_STABLE_MS) {
                    return latestSnapshot;
                }
            }

            await sleep(generationInProgress ? 400 : SHORT_DELAY_MS);
        }

        return latestSnapshot;
    }

    function getLatestAssistantMessageSnapshot() {
        const candidates = collectAssistantMessageCandidates();
        if (!candidates.length) {
            return null;
        }

        return candidates[candidates.length - 1];
    }

    function collectAssistantMessageCandidates() {
        const root = document.querySelector("main") || document;
        const candidates = [];
        const seen = new Set();
        const pushCandidate = (contentNode, hostNode) => {
            if (!(contentNode instanceof HTMLElement)) {
                return;
            }

            const text = normalizeAssistantMessageText(contentNode.innerText || contentNode.textContent || "");
            if (!text) {
                return;
            }

            const keyNode = hostNode instanceof HTMLElement ? hostNode : contentNode;
            const key = getElementKey(keyNode);
            if (seen.has(key)) {
                return;
            }

            seen.add(key);
            candidates.push({ key, text });
        };

        root.querySelectorAll("[data-message-author-role='assistant']").forEach((node) => {
            const contentNode = node.querySelector(".markdown, .prose") || node;
            pushCandidate(contentNode, node.closest("article") || node);
        });

        if (candidates.length === 0) {
            root.querySelectorAll("article .markdown, article .prose").forEach((node) => {
                pushCandidate(node, node.closest("article") || node);
            });
        }

        return candidates;
    }

    function isNewAssistantSnapshot(previousSnapshot, currentSnapshot) {
        if (!currentSnapshot?.text) {
            return false;
        }

        if (!previousSnapshot?.text) {
            return true;
        }

        return currentSnapshot.key !== previousSnapshot.key || currentSnapshot.text !== previousSnapshot.text;
    }

    function normalizeAssistantMessageText(text) {
        return `${text || ""}`
            .replace(/\u200B/g, "")
            .replace(/\r\n?/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    function getElementKey(element) {
        const explicitKey =
            element.getAttribute("data-message-id") ||
            element.getAttribute("data-testid") ||
            element.getAttribute("id");
        if (explicitKey) {
            return explicitKey;
        }

        const pathParts = [];
        let current = element;
        while (current && current !== document.body && pathParts.length < 6) {
            const parent = current.parentElement;
            if (!parent) {
                break;
            }

            const index = Array.prototype.indexOf.call(parent.children, current);
            pathParts.push(`${current.tagName.toLowerCase()}:${index}`);
            current = parent;
        }

        return pathParts.reverse().join(">");
    }

    function insertCharacter(composer, char) {
        const beforeText = normalizeComposerText(getComposerText(composer));
        placeCaretAtEnd(composer);
        dispatchKeyboardSequence(composer, char);

        let insertedByExecCommand = false;
        try {
            insertedByExecCommand = document.execCommand("insertText", false, char);
        } catch (error) {
            console.warn("[chatgpt-web-bridge] execCommand(insertText) threw.", error);
        }

        const afterExecCommandText = normalizeComposerText(getComposerText(composer));
        const expectedAfterText = normalizeComposerText(`${beforeText}${char}`);
        if (!insertedByExecCommand || afterExecCommandText !== expectedAfterText) {
            appendCharacterFallback(composer, beforeText, char);
        }

        composer.dispatchEvent(
            new InputEvent("input", {
                bubbles: true,
                data: char,
                inputType: char === "\n" ? "insertLineBreak" : "insertText"
            })
        );
        return true;
    }

    function placeCaretAtEnd(composer) {
        composer.focus();
        const paragraph = ensureComposerParagraph(composer);
        const selection = window.getSelection();
        if (!selection) {
            return;
        }

        const range = document.createRange();
        const lastTextNode = getLastTextNode(paragraph);
        const trailingBreak = paragraph.querySelector("br.ProseMirror-trailingBreak");
        if (lastTextNode) {
            range.setStart(lastTextNode, lastTextNode.textContent ? lastTextNode.textContent.length : 0);
            range.collapse(true);
        } else if (trailingBreak) {
            range.setStartBefore(trailingBreak);
            range.collapse(true);
        } else {
            range.selectNodeContents(paragraph);
            range.collapse(false);
        }

        selection.removeAllRanges();
        selection.addRange(range);
    }

    function selectComposerContents(composer) {
        const selection = window.getSelection();
        if (!selection) {
            return;
        }

        const range = document.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function ensureComposerParagraph(composer) {
        let paragraph = composer.querySelector("p");
        if (!(paragraph instanceof HTMLParagraphElement)) {
            paragraph = document.createElement("p");
            composer.replaceChildren(paragraph);
        } else {
            for (const child of Array.from(composer.children)) {
                if (child !== paragraph) {
                    child.remove();
                }
            }
        }

        return paragraph;
    }

    function setComposerTextFallback(composer, text) {
        const paragraph = ensureComposerParagraph(composer);
        paragraph.replaceChildren();

        if (text) {
            paragraph.appendChild(document.createTextNode(text));
        } else {
            const trailingBreak = document.createElement("br");
            trailingBreak.className = "ProseMirror-trailingBreak";
            paragraph.appendChild(trailingBreak);
        }
    }

    function appendCharacterFallback(composer, currentText, char) {
        setComposerTextFallback(composer, `${currentText}${char}`);
        placeCaretAtEnd(composer);
    }

    function getLastTextNode(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let lastTextNode = null;
        while (walker.nextNode()) {
            lastTextNode = walker.currentNode;
        }

        return lastTextNode;
    }

    function normalizeComposerText(text) {
        return `${text || ""}`.replace(/\u200B/g, "").replace(/\r\n?/g, "\n");
    }

    function dispatchKeyboardSequence(composer, char) {
        const key = char === "\n" ? "Enter" : char;
        const code = char === "\n" ? "Enter" : "";
        const keyCode = char === "\n" ? 13 : getKeyCode(char);
        const eventOptions = {
            bubbles: true,
            cancelable: true,
            key,
            code,
            which: keyCode,
            keyCode
        };

        composer.dispatchEvent(new KeyboardEvent("keydown", eventOptions));
        composer.dispatchEvent(new KeyboardEvent("keypress", eventOptions));
        composer.dispatchEvent(new KeyboardEvent("keyup", eventOptions));
    }

    function getKeyCode(char) {
        if (!char) {
            return 0;
        }

        return char.toUpperCase().charCodeAt(0);
    }

    function getTypingDelay(char) {
        let delay = randomBetween(TYPING_DELAY_MIN_MS, TYPING_DELAY_MAX_MS);
        if (char === " " || char === "\n" || char === "\t") {
            delay += TYPING_DELAY_SPACE_BONUS_MS;
        }

        if (/[.,!?;:]/.test(char)) {
            delay += TYPING_DELAY_PUNCTUATION_BONUS_MS;
        }

        return delay;
    }

    function findGenerationStopButton() {
        return document.querySelector(
            "button[aria-label*='Stop'], button[aria-label*='Останов'], button[data-testid*='stop']"
        );
    }

    function getPreSubmitDelay() {
        return PRE_SUBMIT_DELAY_MS + randomBetween(PRE_SUBMIT_JITTER_MIN_MS, PRE_SUBMIT_JITTER_MAX_MS);
    }

    function randomBetween(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    async function waitFor(resolver, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const value = resolver();
            if (value) {
                return value;
            }

            await sleep(SHORT_DELAY_MS);
        }

        return null;
    }

    function sleep(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }
})();
