(function () {
    const CHATGPT_HOME_URL = "https://chatgpt.com/";
    const TEMPORARY_CHAT_QUERY_PARAM = "temporary-chat";
    const POLL_DELAY_MS = 2000;
    const SHORT_DELAY_MS = 250;
    const DEFAULT_WAIT_MS = 12000;
    const SEND_TIMEOUT_MS = 8000;
    const RESPONSE_TIMEOUT_MS = 900000;
    const RESPONSE_STABLE_MS = 3000;
    const SESSION_URL_REGEX = /^https:\/\/chatgpt\.com\/c\/[^/?#]+/;
    const TYPING_DELAY_BASE_MIN_MS = 45;
    const TYPING_DELAY_BASE_MAX_MS = 170;
    const TYPING_DELAY_SPACE_BONUS_MS = 90;
    const TYPING_DELAY_PUNCTUATION_BONUS_MS = 140;
    const DEFAULT_TYPING_SPEED_MULTIPLIER = 4;
    const PRE_SUBMIT_DELAY_MS = 1000;
    const PRE_SUBMIT_JITTER_MIN_MS = 180;
    const PRE_SUBMIT_JITTER_MAX_MS = 900;
    const PROMPT_SUBMIT_MAX_ATTEMPTS = 2;
    const PROMPT_RETRY_DELAY_MS = 1200;
    const SEND_BUTTON_WAIT_MS = 5000;
    const SEND_ACK_RETRY_WAIT_MS = 1500;

    let loopStarted = false;
    let currentJobId = null;
    let currentAutomationCommandId = null;
    let lastLoopStateSignature = null;

    initializeAutomationTab().catch((error) => {
        console.error("[chatgpt-web-bridge] Failed to initialize the automation tab.", error);
        void emitDiagnosticLog("error", "Failed to initialize the automation tab.", {
            error: error instanceof Error ? error.message : String(error)
        });
    });

    startLoop().catch((error) => {
        console.error("[chatgpt-web-bridge] Failed to start the content loop.", error);
        void emitDiagnosticLog("error", "Failed to start the content loop.", {
            error: error instanceof Error ? error.message : String(error)
        });
    });

    async function initializeAutomationTab() {
        const claimResult = await browser.runtime.sendMessage({
            type: "claimAutomationTab"
        });
        if (!claimResult?.ok) {
            return;
        }

        try {
            const metadata = claimResult.metadata || null;
            const composer = await waitForComposer(DEFAULT_WAIT_MS);
            if (!composer) {
                throw new Error("Composer was not found on the page.");
            }

            if (metadata?.isTemporary) {
                const enabled = await ensureTemporaryChatMode(DEFAULT_WAIT_MS);
                if (!enabled) {
                    throw new Error("Temporary chat mode could not be enabled.");
                }
            }

            await browser.runtime.sendMessage({
                type: "reportSessionReady",
                detail: metadata?.isTemporary ? "Temporary chat is ready." : "Fresh chat is ready.",
                isTemporary: Boolean(metadata?.isTemporary),
                conversationUrl: extractConversationUrl(location.href) || undefined
            });
        } catch (error) {
            await browser.runtime.sendMessage({
                type: "reportSessionError",
                detail: error instanceof Error ? error.message : String(error)
            });
        }
    }

    async function startLoop() {
        if (loopStarted) {
            return;
        }

        loopStarted = true;
        await emitDiagnosticLog("info", "Content loop started.", {
            url: location.href
        });

        while (true) {
            try {
                const automationTab = await isDedicatedAutomationTab();
                if (!automationTab.isAutomationTab) {
                    await recordLoopState("waiting-for-automation-tab", {
                        url: location.href
                    });
                    await sleep(POLL_DELAY_MS);
                    continue;
                }

                const automationContext = await getAutomationContext();
                const metadata = automationContext?.context || null;
                if (!metadata?.sessionToken) {
                    await recordLoopState("waiting-for-session-context", {
                        url: location.href
                    });
                    await sleep(POLL_DELAY_MS);
                    continue;
                }

                if (!ensureCorrectPage(metadata)) {
                    await recordLoopState("waiting-for-correct-page", {
                        url: location.href,
                        conversationUrl: metadata.conversationUrl || null
                    });
                    await sleep(POLL_DELAY_MS);
                    continue;
                }

                if (!currentAutomationCommandId) {
                    const command = await getPendingAutomationCommand();
                    if (command) {
                        currentAutomationCommandId = command.commandId;
                        await executeAutomationCommand(command);
                        continue;
                    }
                }

                if (currentJobId) {
                    await recordLoopState("job-in-progress", {
                        jobId: currentJobId,
                        url: location.href
                    });
                    await sleep(POLL_DELAY_MS);
                    continue;
                }

                const job = await getPendingJob();
                if (!job) {
                    await recordLoopState("waiting-for-job", {
                        sessionToken: metadata.sessionToken,
                        url: location.href
                    });
                    await sleep(POLL_DELAY_MS);
                    continue;
                }

                currentJobId = job.commandId;
                await executeJob(job, metadata);
            } catch (error) {
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
            if (command.type === "set-temporary") {
                await executeSetTemporaryCommand(command.commandId);
                return;
            }

            throw new Error(`Unsupported automation command: ${command.type}`);
        } catch (error) {
            await browser.runtime.sendMessage({
                type: "reportAutomationCommandResult",
                commandId: command.commandId,
                status: "failed",
                detail: error instanceof Error ? error.message : String(error)
            });
        } finally {
            currentAutomationCommandId = null;
            await sleep(POLL_DELAY_MS);
        }
    }

    async function executeSetTemporaryCommand(commandId) {
        if (!isChatHome(location.href)) {
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

        await browser.runtime.sendMessage({
            type: "reportAutomationCommandResult",
            commandId,
            status: "completed",
            detail: "Temporary chat mode is enabled.",
            isTemporary: true
        });
    }

    async function executeJob(job, metadata) {
        try {
            const typingSpeedMultiplier = await getTypingSpeedMultiplier();
            const previousAssistantSnapshot = getLatestAssistantMessageSnapshot();
            await emitDiagnosticLog("info", "Starting prompt dispatch.", {
                commandId: job.commandId,
                textLength: job.request.length
            });
            await dispatchPromptWithRetry(job.request, typingSpeedMultiplier);

            const acceptedResult = await browser.runtime.sendMessage({
                type: "reportJobAccepted",
                commandId: job.commandId,
                detail: "Prompt was sent.",
                conversationUrl: extractConversationUrl(location.href) || metadata.conversationUrl || undefined
            });
            if (!acceptedResult?.ok) {
                throw new Error(acceptedResult?.error || "The browser agent did not confirm the prompt dispatch.");
            }

            const conversationUrl =
                (await waitForConversationUrl(5000)) ||
                extractConversationUrl(location.href) ||
                metadata.conversationUrl ||
                undefined;

            const assistantResponse = await waitForAssistantResponse(previousAssistantSnapshot, RESPONSE_TIMEOUT_MS);
            if (!assistantResponse?.text) {
                throw new Error("Assistant response was not captured in time.");
            }

            await emitDiagnosticLog("info", "Assistant response captured.", {
                commandId: job.commandId,
                responseLength: assistantResponse.text.length
            });

            await browser.runtime.sendMessage({
                type: "reportJobResult",
                commandId: job.commandId,
                status: "sent",
                detail: "Assistant response was captured.",
                conversationUrl,
                responseText: assistantResponse.text
            });
        } catch (error) {
            await emitDiagnosticLog("error", "Prompt execution failed.", {
                commandId: job.commandId,
                error: error instanceof Error ? error.message : String(error)
            });
            await browser.runtime.sendMessage({
                type: "reportJobResult",
                commandId: job.commandId,
                status: "failed",
                detail: error instanceof Error ? error.message : String(error),
                conversationUrl: extractConversationUrl(location.href) || undefined
            });
        } finally {
            currentJobId = null;
            await sleep(POLL_DELAY_MS);
        }
    }

    async function dispatchPromptWithRetry(requestText, typingSpeedMultiplier) {
        let lastError = new Error("Failed to send the prompt.");
        for (let attempt = 1; attempt <= PROMPT_SUBMIT_MAX_ATTEMPTS; attempt += 1) {
            try {
                const attemptStartedAt = Date.now();
                const composer = await waitForComposer(DEFAULT_WAIT_MS);
                if (!composer) {
                    throw new Error("Composer was not found on the page.");
                }
                const immediateInsertion = shouldUseImmediatePromptInsertion();

                await emitDiagnosticLog("debug", "Prompt dispatch attempt started.", {
                    attempt,
                    maxAttempts: PROMPT_SUBMIT_MAX_ATTEMPTS,
                    textLength: requestText.length,
                    immediateInsertion
                });

                clearComposer(composer);
                const inserted = await insertPromptText(composer, requestText, typingSpeedMultiplier);
                if (!inserted) {
                    throw new Error("Failed to insert text into the ChatGPT composer.");
                }

                await emitDiagnosticLog("debug", "Prompt inserted into the composer.", {
                    attempt,
                    insertDurationMs: Date.now() - attemptStartedAt,
                    composerLength: getComposerText(composer).length,
                    immediateInsertion
                });

                await sleep(getPreSubmitDelay());
                const submitStartedAt = Date.now();
                const submitted = await submitPrompt(composer);
                if (!submitted) {
                    throw new Error("Send button did not become available.");
                }

                const sent = await waitForSendFeedback(composer);
                if (!sent) {
                    throw new Error("ChatGPT did not acknowledge the send action in time.");
                }

                await emitDiagnosticLog("info", "Prompt submit acknowledged by the UI.", {
                    attempt,
                    submitDurationMs: Date.now() - submitStartedAt,
                    totalAttemptDurationMs: Date.now() - attemptStartedAt
                });

                return;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                if (attempt >= PROMPT_SUBMIT_MAX_ATTEMPTS) {
                    break;
                }

                await emitDiagnosticLog("warn", "Prompt dispatch attempt failed. Retrying.", {
                    attempt,
                    maxAttempts: PROMPT_SUBMIT_MAX_ATTEMPTS,
                    error: lastError.message,
                    textLength: requestText.length
                });
                await sleep(PROMPT_RETRY_DELAY_MS);
            }
        }

        throw lastError;
    }

    async function isDedicatedAutomationTab() {
        const result = await browser.runtime.sendMessage({
            type: "isAutomationTab"
        });
        return {
            isAutomationTab: Boolean(result?.isAutomationTab),
            metadata: result?.metadata || null
        };
    }

    async function getAutomationContext() {
        return await browser.runtime.sendMessage({
            type: "getAutomationContext"
        });
    }

    async function getPendingAutomationCommand() {
        return await browser.runtime.sendMessage({
            type: "getPendingAutomationCommand"
        });
    }

    async function getPendingJob() {
        return await browser.runtime.sendMessage({
            type: "getPendingJob"
        });
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
        } catch {
            return;
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

    function ensureCorrectPage(metadata) {
        const targetUrl = metadata?.conversationUrl || CHATGPT_HOME_URL;
        if (!metadata?.conversationUrl) {
            if (!isChatHome(location.href)) {
                location.href = CHATGPT_HOME_URL;
                return false;
            }

            return true;
        }

        if (!location.href.startsWith(targetUrl)) {
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
            console.warn("[chatgpt-web-bridge] Failed to parse a ChatGPT home URL.", url, error);
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

    async function insertPromptText(composer, text, typingSpeedMultiplier) {
        const immediateInsertion = shouldUseImmediatePromptInsertion();
        for (const char of text) {
            const inserted = insertCharacter(composer, char);
            if (!inserted) {
                return false;
            }

            if (!immediateInsertion) {
                await sleep(getTypingDelay(char, typingSpeedMultiplier));
            }
        }

        composer.dispatchEvent(new Event("change", { bubbles: true }));
        return normalizeComposerText(getComposerText(composer)) === normalizeComposerText(text);
    }

    async function getTypingSpeedMultiplier() {
        try {
            const config = await browser.runtime.sendMessage({
                type: "loadAgentConfig"
            });
            return normalizeTypingSpeedMultiplier(config?.typingSpeedMultiplier) || DEFAULT_TYPING_SPEED_MULTIPLIER;
        } catch {
            return DEFAULT_TYPING_SPEED_MULTIPLIER;
        }
    }

    async function submitPrompt(composer) {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            const sendButton = await waitFor(findSendButton, SEND_BUTTON_WAIT_MS);
            if (sendButton) {
                try {
                    sendButton.focus();
                } catch {
                    // Ignore focus failures and keep trying to submit.
                }

                sendButton.click();
                const acknowledged = await waitFor(() => {
                    if (!getComposerText(composer).trim()) {
                        return true;
                    }

                    return findGenerationStopButton();
                }, SEND_ACK_RETRY_WAIT_MS);
                if (acknowledged) {
                    return true;
                }
            }
        }

        return triggerEnterFallback(composer);
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
        if (typeof composer?.innerText === "string" && composer.innerText) {
            return composer.innerText.replace(/\n$/, "");
        }

        return composer?.textContent || "";
    }

    async function ensureTemporaryChatMode(timeoutMs) {
        if (isTemporaryChatEnabled()) {
            return true;
        }

        const button = await waitFor(findTemporaryChatEnableButton, timeoutMs);
        if (!(button instanceof HTMLButtonElement)) {
            return false;
        }

        button.click();
        const enabled = await waitFor(() => (isTemporaryChatEnabled() ? true : null), timeoutMs);
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
        } catch {
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

    async function waitForAssistantResponse(previousSnapshot, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        let latestSnapshot = null;
        let stableSince = 0;

        while (Date.now() < deadline) {
            const currentSnapshot = getLatestAssistantMessageSnapshot();
            const renderInProgress = isAssistantRenderInProgress(currentSnapshot);
            const hasNewAssistantContent = isNewAssistantSnapshot(previousSnapshot, currentSnapshot);

            if (hasNewAssistantContent) {
                if (!latestSnapshot || latestSnapshot.key !== currentSnapshot.key || latestSnapshot.text !== currentSnapshot.text) {
                    latestSnapshot = currentSnapshot;
                    stableSince = Date.now();
                } else if (!renderInProgress && latestSnapshot.text && Date.now() - stableSince >= RESPONSE_STABLE_MS) {
                    return latestSnapshot;
                }
            }

            await sleep(renderInProgress ? 400 : SHORT_DELAY_MS);
        }

        return null;
    }

    function isAssistantRenderInProgress(snapshot) {
        if (findGenerationStopButton()) {
            return true;
        }

        return hasWritingBlock(snapshot?.turnNode || snapshot?.messageNode || null);
    }

    function hasWritingBlock(node) {
        if (!(node instanceof HTMLElement)) {
            return false;
        }

        return Boolean(node.querySelector("[data-writing-block]"));
    }

    function getLatestAssistantMessageSnapshot() {
        const candidates = collectAssistantTurnCandidates();
        if (candidates.length) {
            return candidates[candidates.length - 1];
        }

        const fallbackCandidates = collectAssistantMessageCandidates();
        if (!fallbackCandidates.length) {
            return null;
        }

        return fallbackCandidates[fallbackCandidates.length - 1];
    }

    function collectAssistantTurnCandidates() {
        const root = document.querySelector("main") || document;
        const turns = [];
        const seen = new Set();
        root.querySelectorAll("section[data-turn='assistant']").forEach((turnNode) => {
            if (!(turnNode instanceof HTMLElement)) {
                return;
            }

            const messageNode = selectPreferredAssistantMessageNode(turnNode);
            if (!(messageNode instanceof HTMLElement)) {
                return;
            }

            const text = extractAssistantMessageText(messageNode);
            if (!text) {
                return;
            }

            const key = turnNode.getAttribute("data-turn-id") || getElementKey(messageNode);
            if (seen.has(key)) {
                return;
            }

            seen.add(key);
            turns.push({
                key,
                text,
                messageNode,
                turnNode
            });
        });

        return turns;
    }

    function selectPreferredAssistantMessageNode(turnNode) {
        if (!(turnNode instanceof HTMLElement)) {
            return null;
        }

        const turnStartCandidates = Array.from(
            turnNode.querySelectorAll("[data-message-author-role='assistant'][data-turn-start-message='true']")
        ).filter((node) => node instanceof HTMLElement);
        if (turnStartCandidates.length > 0) {
            return turnStartCandidates[turnStartCandidates.length - 1];
        }

        const assistantNodes = Array.from(turnNode.querySelectorAll("[data-message-author-role='assistant']")).filter(
            (node) => node instanceof HTMLElement
        );
        if (assistantNodes.length === 1) {
            return assistantNodes[0];
        }

        return null;
    }

    function collectAssistantMessageCandidates() {
        const root = document.querySelector("main") || document;
        const candidates = [];
        const seen = new Set();
        const pushCandidate = (messageNode, hostNode, turnNode = null) => {
            if (!(messageNode instanceof HTMLElement)) {
                return;
            }

            const text = extractAssistantMessageText(messageNode);
            if (!text) {
                return;
            }

            const keyNode = hostNode instanceof HTMLElement ? hostNode : messageNode;
            const key = getElementKey(keyNode);
            if (seen.has(key)) {
                return;
            }

            seen.add(key);
            candidates.push({
                key,
                text,
                messageNode,
                turnNode: turnNode instanceof HTMLElement ? turnNode : null
            });
        };

        root.querySelectorAll("[data-message-author-role='assistant']").forEach((node) => {
            pushCandidate(node, node.closest("article") || node, node.closest("section[data-turn='assistant']"));
        });

        if (candidates.length === 0) {
            const fallbackHosts = new Set();
            root.querySelectorAll("article .markdown, article .prose").forEach((node) => {
                const hostNode = node.closest("article") || node;
                if (!(hostNode instanceof HTMLElement) || fallbackHosts.has(hostNode)) {
                    return;
                }

                fallbackHosts.add(hostNode);
                pushCandidate(hostNode, hostNode, hostNode.closest("section[data-turn='assistant']"));
            });
        }

        return candidates;
    }

    function extractAssistantMessageText(messageNode) {
        if (!(messageNode instanceof HTMLElement)) {
            return "";
        }

        const contentNodes = getTopLevelAssistantContentNodes(messageNode);
        const parts = [];
        const seen = new Set();

        for (const contentNode of contentNodes) {
            const text = normalizeAssistantMessageText(contentNode.innerText || contentNode.textContent || "");
            if (!text || seen.has(text)) {
                continue;
            }

            seen.add(text);
            parts.push(text);
        }

        return normalizeAssistantMessageText(parts.join("\n\n"));
    }

    function getTopLevelAssistantContentNodes(messageNode) {
        const contentNodes = Array.from(messageNode.querySelectorAll(".markdown, .prose")).filter((node) => node instanceof HTMLElement);
        if (contentNodes.length === 0) {
            return [messageNode];
        }

        return contentNodes.filter((candidate) => !contentNodes.some((other) => other !== candidate && other.contains(candidate)));
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
        return `${text || ""}`.replace(/\u200B/g, "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    function getElementKey(element) {
        const explicitKey = element.getAttribute("data-message-id") || element.getAttribute("data-testid") || element.getAttribute("id");
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
        if (shouldDispatchKeyboardSequence(char)) {
            dispatchKeyboardSequence(composer, char);
        }

        let insertedByExecCommand = false;
        try {
            insertedByExecCommand = document.execCommand("insertText", false, char);
        } catch {
            insertedByExecCommand = false;
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

    function shouldDispatchKeyboardSequence(char) {
        if (!char) {
            return false;
        }

        return !/[\r\n\t]/.test(char);
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
        return `${text || ""}`
            .replace(/\u00A0/g, " ")
            .replace(/\u200B/g, "")
            .replace(/\r\n?/g, "\n");
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
        return label.includes("голос") || label.includes("voice") ? null : submitStyled;
    }

    function isEnabledSubmitCandidate(button) {
        if (!(button instanceof HTMLButtonElement) || button.disabled) {
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

    function shouldUseImmediatePromptInsertion() {
        if (document.hidden) {
            return true;
        }

        try {
            return typeof document.hasFocus === "function" && !document.hasFocus();
        } catch {
            return false;
        }
    }

    function getTypingDelay(char, typingSpeedMultiplier = DEFAULT_TYPING_SPEED_MULTIPLIER) {
        let delay = randomBetween(TYPING_DELAY_BASE_MIN_MS, TYPING_DELAY_BASE_MAX_MS);
        if (char === " " || char === "\n" || char === "\t") {
            delay += TYPING_DELAY_SPACE_BONUS_MS;
        }

        if (/[.,!?;:]/.test(char)) {
            delay += TYPING_DELAY_PUNCTUATION_BONUS_MS;
        }

        return Math.max(1, Math.round(delay / normalizeTypingSpeedMultiplier(typingSpeedMultiplier)));
    }

    function normalizeTypingSpeedMultiplier(value) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            return value;
        }

        if (typeof value !== "string") {
            return DEFAULT_TYPING_SPEED_MULTIPLIER;
        }

        const normalized = Number.parseFloat(value.trim().replace(",", "."));
        if (!Number.isFinite(normalized) || normalized <= 0) {
            return DEFAULT_TYPING_SPEED_MULTIPLIER;
        }

        return normalized;
    }

    function findGenerationStopButton() {
        return document.querySelector("button[aria-label*='Stop'], button[aria-label*='Останов'], button[data-testid*='stop']");
    }

    function getPreSubmitDelay() {
        if (shouldUseImmediatePromptInsertion()) {
            return SHORT_DELAY_MS;
        }

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
