import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

async function loadContentScriptHelpers() {
    const source = await readFile(join(projectDir, "extension", "content-script.js"), "utf8");
    const homeUrlMatch = source.match(/const CHATGPT_HOME_URL = "([^"]+)";/);
    const isChatHomePathMatch = source.match(/function isChatHomePath\(pathname\) \{[\s\S]*?\n    \}/);
    const isChatHomeMatch = source.match(/function isChatHome\(url\) \{[\s\S]*?\n    \}/);

    assert.ok(homeUrlMatch, "CHATGPT_HOME_URL should be declared in content-script.js");
    assert.ok(isChatHomePathMatch, "isChatHomePath() should be declared in content-script.js");
    assert.ok(isChatHomeMatch, "isChatHome() should be declared in content-script.js");

    const module = { exports: {} };
    const factory = new Function(
        "module",
        "exports",
        `"use strict"; const CHATGPT_HOME_URL = ${JSON.stringify(homeUrlMatch[1])}; ${isChatHomePathMatch[0]} ${isChatHomeMatch[0]} module.exports = { isChatHome, isChatHomePath };`
    );
    factory(module, module.exports);
    return module.exports;
}

async function loadTypingDelayConfig() {
    const source = await readFile(join(projectDir, "extension", "content-script.js"), "utf8");
    const baseMinMatch = source.match(/const TYPING_DELAY_BASE_MIN_MS = (\d+);/);
    const baseMaxMatch = source.match(/const TYPING_DELAY_BASE_MAX_MS = (\d+);/);
    const spaceBonusMatch = source.match(/const TYPING_DELAY_SPACE_BONUS_MS = (\d+);/);
    const punctuationBonusMatch = source.match(/const TYPING_DELAY_PUNCTUATION_BONUS_MS = (\d+);/);
    const defaultMultiplierMatch = source.match(/const DEFAULT_TYPING_SPEED_MULTIPLIER = (\d+);/);
    const shortDelayMatch = source.match(/const SHORT_DELAY_MS = (\d+);/);
    const preSubmitDelayMatch = source.match(/const PRE_SUBMIT_DELAY_MS = (\d+);/);
    const preSubmitJitterMinMatch = source.match(/const PRE_SUBMIT_JITTER_MIN_MS = (\d+);/);
    const preSubmitJitterMaxMatch = source.match(/const PRE_SUBMIT_JITTER_MAX_MS = (\d+);/);
    const normalizeTypingSpeedMultiplierMatch = source.match(/function normalizeTypingSpeedMultiplier\(value\) \{[\s\S]*?\n    \}/);
    const shouldUseImmediatePromptInsertionMatch = source.match(/function shouldUseImmediatePromptInsertion\(\) \{[\s\S]*?\n    \}/);
    const randomBetweenMatch = source.match(/function randomBetween\(min, max\) \{[\s\S]*?\n    \}/);
    const getTypingDelayMatch = source.match(/function getTypingDelay\(char, typingSpeedMultiplier = DEFAULT_TYPING_SPEED_MULTIPLIER\) \{[\s\S]*?\n    \}/);
    const getPreSubmitDelayMatch = source.match(/function getPreSubmitDelay\(\) \{[\s\S]*?\n    \}/);

    assert.ok(baseMinMatch, "TYPING_DELAY_BASE_MIN_MS should be declared in content-script.js");
    assert.ok(baseMaxMatch, "TYPING_DELAY_BASE_MAX_MS should be declared in content-script.js");
    assert.ok(spaceBonusMatch, "TYPING_DELAY_SPACE_BONUS_MS should be declared in content-script.js");
    assert.ok(punctuationBonusMatch, "TYPING_DELAY_PUNCTUATION_BONUS_MS should be declared in content-script.js");
    assert.ok(defaultMultiplierMatch, "DEFAULT_TYPING_SPEED_MULTIPLIER should be declared in content-script.js");
    assert.ok(shortDelayMatch, "SHORT_DELAY_MS should be declared in content-script.js");
    assert.ok(preSubmitDelayMatch, "PRE_SUBMIT_DELAY_MS should be declared in content-script.js");
    assert.ok(preSubmitJitterMinMatch, "PRE_SUBMIT_JITTER_MIN_MS should be declared in content-script.js");
    assert.ok(preSubmitJitterMaxMatch, "PRE_SUBMIT_JITTER_MAX_MS should be declared in content-script.js");
    assert.ok(normalizeTypingSpeedMultiplierMatch, "normalizeTypingSpeedMultiplier() should be declared in content-script.js");
    assert.ok(shouldUseImmediatePromptInsertionMatch, "shouldUseImmediatePromptInsertion() should be declared in content-script.js");
    assert.ok(randomBetweenMatch, "randomBetween() should be declared in content-script.js");
    assert.ok(getTypingDelayMatch, "getTypingDelay() should be declared in content-script.js");
    assert.ok(getPreSubmitDelayMatch, "getPreSubmitDelay() should be declared in content-script.js");

    const module = { exports: {} };
    const factory = new Function(
        "module",
        "exports",
        "document",
        `"use strict";
        const SHORT_DELAY_MS = ${Number(shortDelayMatch[1])};
        const TYPING_DELAY_BASE_MIN_MS = ${Number(baseMinMatch[1])};
        const TYPING_DELAY_BASE_MAX_MS = ${Number(baseMaxMatch[1])};
        const TYPING_DELAY_SPACE_BONUS_MS = ${Number(spaceBonusMatch[1])};
        const TYPING_DELAY_PUNCTUATION_BONUS_MS = ${Number(punctuationBonusMatch[1])};
        const DEFAULT_TYPING_SPEED_MULTIPLIER = ${Number(defaultMultiplierMatch[1])};
        const PRE_SUBMIT_DELAY_MS = ${Number(preSubmitDelayMatch[1])};
        const PRE_SUBMIT_JITTER_MIN_MS = ${Number(preSubmitJitterMinMatch[1])};
        const PRE_SUBMIT_JITTER_MAX_MS = ${Number(preSubmitJitterMaxMatch[1])};
        ${normalizeTypingSpeedMultiplierMatch[0]}
        ${shouldUseImmediatePromptInsertionMatch[0]}
        ${randomBetweenMatch[0]}
        ${getTypingDelayMatch[0]}
        ${getPreSubmitDelayMatch[0]}
        module.exports = {
            shortDelayMs: SHORT_DELAY_MS,
            baseMinMs: TYPING_DELAY_BASE_MIN_MS,
            baseMaxMs: TYPING_DELAY_BASE_MAX_MS,
            spaceBonusMs: TYPING_DELAY_SPACE_BONUS_MS,
            punctuationBonusMs: TYPING_DELAY_PUNCTUATION_BONUS_MS,
            defaultMultiplier: DEFAULT_TYPING_SPEED_MULTIPLIER,
            normalizeTypingSpeedMultiplier,
            shouldUseImmediatePromptInsertion,
            getTypingDelay,
            getPreSubmitDelay
        };`
    );
    const fakeDocument = {
        hidden: false,
        _hasFocus: true,
        hasFocus() {
            return this._hasFocus;
        }
    };
    factory(module, module.exports, fakeDocument);
    return {
        ...module.exports,
        fakeDocument
    };
}

async function loadKeyboardDispatchHelper() {
    const source = await readFile(join(projectDir, "extension", "content-script.js"), "utf8");
    const shouldDispatchKeyboardSequenceMatch = source.match(/function shouldDispatchKeyboardSequence\(char\) \{[\s\S]*?\n    \}/);

    assert.ok(shouldDispatchKeyboardSequenceMatch, "shouldDispatchKeyboardSequence() should be declared in content-script.js");

    const module = { exports: {} };
    const factory = new Function(
        "module",
        "exports",
        `"use strict";
        ${shouldDispatchKeyboardSequenceMatch[0]}
        module.exports = { shouldDispatchKeyboardSequence };`
    );
    factory(module, module.exports);
    return module.exports;
}

async function loadComposerTextHelpers() {
    const source = await readFile(join(projectDir, "extension", "content-script.js"), "utf8");
    const getComposerTextMatch = source.match(/function getComposerText\(composer\) \{[\s\S]*?\n    \}/);
    const normalizeComposerTextMatch = source.match(/function normalizeComposerText\(text\) \{[\s\S]*?\n    \}/);

    assert.ok(getComposerTextMatch, "getComposerText() should be declared in content-script.js");
    assert.ok(normalizeComposerTextMatch, "normalizeComposerText() should be declared in content-script.js");

    const module = { exports: {} };
    const factory = new Function(
        "module",
        "exports",
        `"use strict";
        ${getComposerTextMatch[0]}
        ${normalizeComposerTextMatch[0]}
        module.exports = { getComposerText, normalizeComposerText };`
    );
    factory(module, module.exports);
    return module.exports;
}

async function loadAssistantMessageHelpers() {
    const source = await readFile(join(projectDir, "extension", "content-script.js"), "utf8");
    const normalizeAssistantMessageTextMatch = source.match(/function normalizeAssistantMessageText\(text\) \{[\s\S]*?\n    \}/);
    const getTopLevelAssistantContentNodesMatch = source.match(/function getTopLevelAssistantContentNodes\(messageNode\) \{[\s\S]*?\n    \}/);
    const extractAssistantMessageTextMatch = source.match(/function extractAssistantMessageText\(messageNode\) \{[\s\S]*?\n    \}/);
    const selectPreferredAssistantMessageNodeMatch = source.match(/function selectPreferredAssistantMessageNode\(turnNode\) \{[\s\S]*?\n    \}/);

    assert.ok(normalizeAssistantMessageTextMatch, "normalizeAssistantMessageText() should be declared in content-script.js");
    assert.ok(getTopLevelAssistantContentNodesMatch, "getTopLevelAssistantContentNodes() should be declared in content-script.js");
    assert.ok(extractAssistantMessageTextMatch, "extractAssistantMessageText() should be declared in content-script.js");
    assert.ok(selectPreferredAssistantMessageNodeMatch, "selectPreferredAssistantMessageNode() should be declared in content-script.js");

    class FakeElement {
        constructor({ tagName = "div", className = "", text = "", attributes = {} } = {}) {
            this.tagName = `${tagName}`.toUpperCase();
            this.className = className;
            this.innerText = text;
            this.textContent = text;
            this.attributes = { ...attributes };
            this.parentElement = null;
            this.children = [];
        }

        appendChild(child) {
            child.parentElement = this;
            this.children.push(child);
            return child;
        }

        contains(target) {
            let current = target;
            while (current) {
                if (current === this) {
                    return true;
                }
                current = current.parentElement;
            }
            return false;
        }

        getAttribute(name) {
            return this.attributes[name] ?? null;
        }

        querySelectorAll(selector) {
            const results = [];
            const selectors = `${selector}`.split(",").map((part) => part.trim()).filter(Boolean);
            const visit = (node) => {
                for (const child of node.children) {
                    if (selectors.some((entry) => child.matchesSelector(entry))) {
                        results.push(child);
                    }
                    visit(child);
                }
            };

            visit(this);
            return results;
        }

        querySelector(selector) {
            return this.querySelectorAll(selector)[0] || null;
        }

        closest(selector) {
            let current = this;
            while (current) {
                if (current.matchesSelector(selector)) {
                    return current;
                }
                current = current.parentElement;
            }

            return null;
        }

        matchesSelector(selector) {
            const normalizedSelector = `${selector}`.trim();
            if (!normalizedSelector) {
                return false;
            }

            if (normalizedSelector.includes(" ")) {
                const [ancestorSelector, descendantSelector] = normalizedSelector.split(/\s+/, 2);
                return this.matchesSelector(descendantSelector) && Boolean(this.closest(ancestorSelector));
            }

            const classes = new Set(`${this.className || ""}`.split(/\s+/).filter(Boolean));
            if (normalizedSelector === ".markdown") {
                return classes.has("markdown");
            }

            if (normalizedSelector === ".prose") {
                return classes.has("prose");
            }

            if (normalizedSelector === "section[data-turn='assistant']") {
                return this.tagName === "SECTION" && this.getAttribute("data-turn") === "assistant";
            }

            if (normalizedSelector === "[data-writing-block]") {
                return this.getAttribute("data-writing-block") !== null;
            }

            if (normalizedSelector === "[data-message-author-role='assistant']") {
                return this.getAttribute("data-message-author-role") === "assistant";
            }

            if (normalizedSelector === "[data-message-author-role='assistant'][data-turn-start-message='true']") {
                return this.getAttribute("data-message-author-role") === "assistant" &&
                    this.getAttribute("data-turn-start-message") === "true";
            }

            return false;
        }
    }

    const module = { exports: {} };
    const factory = new Function(
        "module",
        "exports",
        "HTMLElement",
        `"use strict";
        ${normalizeAssistantMessageTextMatch[0]}
        ${getTopLevelAssistantContentNodesMatch[0]}
        ${extractAssistantMessageTextMatch[0]}
        ${selectPreferredAssistantMessageNodeMatch[0]}
        module.exports = {
            normalizeAssistantMessageText,
            getTopLevelAssistantContentNodes,
            extractAssistantMessageText,
            selectPreferredAssistantMessageNode
        };`
    );
    factory(module, module.exports, FakeElement);
    return {
        ...module.exports,
        FakeElement
    };
}

async function loadAssistantResponseWaiter() {
    const source = await readFile(join(projectDir, "extension", "content-script.js"), "utf8");
    const shortDelayMatch = source.match(/const SHORT_DELAY_MS = (\d+);/);
    const responseStableMatch = source.match(/const RESPONSE_STABLE_MS = (\d+);/);
    const isNewAssistantSnapshotMatch = source.match(/function isNewAssistantSnapshot\(previousSnapshot, currentSnapshot\) \{[\s\S]*?\n    \}/);
    const hasWritingBlockMatch = source.match(/function hasWritingBlock\(node\) \{[\s\S]*?\n    \}/);
    const isAssistantRenderInProgressMatch = source.match(/function isAssistantRenderInProgress\(snapshot\) \{[\s\S]*?\n    \}/);
    const waitForAssistantResponseMatch = source.match(/async function waitForAssistantResponse\(previousSnapshot, timeoutMs\) \{[\s\S]*?\n    \}/);

    assert.ok(shortDelayMatch, "SHORT_DELAY_MS should be declared in content-script.js");
    assert.ok(responseStableMatch, "RESPONSE_STABLE_MS should be declared in content-script.js");
    assert.ok(isNewAssistantSnapshotMatch, "isNewAssistantSnapshot() should be declared in content-script.js");
    assert.ok(hasWritingBlockMatch, "hasWritingBlock() should be declared in content-script.js");
    assert.ok(isAssistantRenderInProgressMatch, "isAssistantRenderInProgress() should be declared in content-script.js");
    assert.ok(waitForAssistantResponseMatch, "waitForAssistantResponse() should be declared in content-script.js");

    class FakeElement {
        constructor({ attributes = {} } = {}) {
            this.attributes = { ...attributes };
            this.children = [];
            this.parentElement = null;
        }

        appendChild(child) {
            child.parentElement = this;
            this.children.push(child);
            return child;
        }

        getAttribute(name) {
            return this.attributes[name] ?? null;
        }

        querySelector(selector) {
            if (selector !== "[data-writing-block]") {
                return null;
            }

            return this.querySelectorAll(selector)[0] || null;
        }

        querySelectorAll(selector) {
            if (selector !== "[data-writing-block]") {
                return [];
            }

            const results = [];
            const visit = (node) => {
                for (const child of node.children) {
                    if (child.getAttribute("data-writing-block") !== null) {
                        results.push(child);
                    }
                    visit(child);
                }
            };

            visit(this);
            return results;
        }
    }

    const module = { exports: {} };
    const factory = new Function(
        "module",
        "exports",
        "HTMLElement",
        "getLatestAssistantMessageSnapshot",
        "findGenerationStopButton",
        "sleep",
        `"use strict";
        const SHORT_DELAY_MS = ${Number(shortDelayMatch[1])};
        const RESPONSE_STABLE_MS = ${Number(responseStableMatch[1])};
        ${isNewAssistantSnapshotMatch[0]}
        ${hasWritingBlockMatch[0]}
        ${isAssistantRenderInProgressMatch[0]}
        ${waitForAssistantResponseMatch[0]}
        module.exports = { waitForAssistantResponse };`
    );

    return function createWaiter(dependencies) {
        factory(
            module,
            module.exports,
            FakeElement,
            dependencies.getLatestAssistantMessageSnapshot,
            dependencies.findGenerationStopButton,
            dependencies.sleep
        );
        return module.exports;
    };
}

test("content script treats localized ChatGPT home URLs as a fresh chat page", async () => {
    const { isChatHome } = await loadContentScriptHelpers();

    assert.equal(isChatHome("https://chatgpt.com/"), true);
    assert.equal(isChatHome("https://chatgpt.com/ru-RU/"), true);
    assert.equal(isChatHome("https://chatgpt.com/ru-RU/?temporary-chat=true"), true);
    assert.equal(isChatHome("https://chatgpt.com/kk/#bridgeClaim=test"), true);
    assert.equal(isChatHome("https://chatgpt.com/c/69d34509-fc88-8391-a2ee-ba71df5a462b"), false);
});

test("content script typing delays respect the configured speed multiplier", async () => {
    const config = await loadTypingDelayConfig();

    assert.deepEqual(
        {
            shortDelayMs: config.shortDelayMs,
            baseMinMs: config.baseMinMs,
            baseMaxMs: config.baseMaxMs,
            spaceBonusMs: config.spaceBonusMs,
            punctuationBonusMs: config.punctuationBonusMs,
            defaultMultiplier: config.defaultMultiplier
        },
        {
        shortDelayMs: 250,
        baseMinMs: 45,
        baseMaxMs: 170,
        spaceBonusMs: 90,
        punctuationBonusMs: 140,
            defaultMultiplier: 4
        }
    );

    assert.equal(config.normalizeTypingSpeedMultiplier("2,5"), 2.5);
    assert.equal(config.normalizeTypingSpeedMultiplier("invalid"), 4);

    const originalRandom = Math.random;
    try {
        Math.random = () => 0;
        assert.equal(config.getTypingDelay("a", 1), 45);
        assert.equal(config.getTypingDelay("a", 4), 11);
        assert.equal(config.getTypingDelay(" ", 4), 34);
        assert.equal(config.getTypingDelay(".", 4), 46);
    } finally {
        Math.random = originalRandom;
    }
});

test("content script uses immediate prompt insertion and short pre-submit delay on background tabs", async () => {
    const config = await loadTypingDelayConfig();

    assert.equal(config.shouldUseImmediatePromptInsertion(), false);
    assert.equal(config.getPreSubmitDelay() >= 1180, true);

    config.fakeDocument.hidden = true;
    try {
        assert.equal(config.shouldUseImmediatePromptInsertion(), true);
        assert.equal(config.getPreSubmitDelay(), 250);
    } finally {
        config.fakeDocument.hidden = false;
    }
});

test("content script does not synthesize Enter-like key events for control whitespace", async () => {
    const { shouldDispatchKeyboardSequence } = await loadKeyboardDispatchHelper();

    assert.equal(shouldDispatchKeyboardSequence("a"), true);
    assert.equal(shouldDispatchKeyboardSequence(" "), true);
    assert.equal(shouldDispatchKeyboardSequence("\n"), false);
    assert.equal(shouldDispatchKeyboardSequence("\r"), false);
    assert.equal(shouldDispatchKeyboardSequence("\t"), false);
});

test("content script reads visible composer text so multiline prompts keep paragraph breaks", async () => {
    const { getComposerText, normalizeComposerText } = await loadComposerTextHelpers();

    const composer = {
        innerText: "Line 1\n\nLine 2\n",
        textContent: "Line 1Line 2"
    };

    assert.equal(getComposerText(composer), "Line 1\n\nLine 2");
    assert.equal(
        normalizeComposerText(getComposerText(composer)),
        normalizeComposerText("Line 1\n\nLine 2")
    );
});

test("content script captures assistant replies rendered across multiple sibling content blocks", async () => {
    const { extractAssistantMessageText, FakeElement } = await loadAssistantMessageHelpers();

    const message = new FakeElement();
    message.appendChild(new FakeElement({
        className: "markdown",
        text: "Section 1\n\nDetails"
    }));
    message.appendChild(new FakeElement({
        className: "prose",
        text: "Section 2\n\nMore details"
    }));

    assert.equal(
        extractAssistantMessageText(message),
        "Section 1\n\nDetails\n\nSection 2\n\nMore details"
    );
});

test("content script avoids duplicating nested assistant content wrappers", async () => {
    const { extractAssistantMessageText, getTopLevelAssistantContentNodes, FakeElement } = await loadAssistantMessageHelpers();

    const message = new FakeElement();
    const wrapper = message.appendChild(new FakeElement({
        className: "prose",
        text: "Full answer\n\nNested part"
    }));
    wrapper.appendChild(new FakeElement({
        className: "markdown",
        text: "Nested part"
    }));

    const contentNodes = getTopLevelAssistantContentNodes(message);
    assert.equal(contentNodes.length, 1);
    assert.equal(contentNodes[0], wrapper);
    assert.equal(extractAssistantMessageText(message), "Full answer\n\nNested part");
});

test("content script prefers the final turn-start assistant message over interim thinking updates", async () => {
    const { selectPreferredAssistantMessageNode, extractAssistantMessageText, FakeElement } = await loadAssistantMessageHelpers();

    const turn = new FakeElement({
        tagName: "section",
        attributes: {
            "data-turn": "assistant"
        }
    });
    turn.appendChild(new FakeElement({
        attributes: {
            "data-message-author-role": "assistant"
        },
        text: "Interim 1"
    }));
    turn.appendChild(new FakeElement({
        attributes: {
            "data-message-author-role": "assistant"
        },
        text: "Interim 2"
    }));
    const finalMessage = turn.appendChild(new FakeElement({
        attributes: {
            "data-message-author-role": "assistant",
            "data-turn-start-message": "true"
        }
    }));
    finalMessage.appendChild(new FakeElement({
        className: "markdown",
        text: "Final answer"
    }));

    assert.equal(selectPreferredAssistantMessageNode(turn), finalMessage);
    assert.equal(extractAssistantMessageText(selectPreferredAssistantMessageNode(turn)), "Final answer");
});

test("content script does not return a partial assistant snapshot when the response wait times out", async () => {
    const createWaiter = await loadAssistantResponseWaiter();
    const partialSnapshot = {
        key: "assistant-turn-1",
        text: "Partial answer",
        messageNode: null,
        turnNode: null
    };

    const { waitForAssistantResponse } = createWaiter({
        getLatestAssistantMessageSnapshot() {
            return partialSnapshot;
        },
        findGenerationStopButton() {
            return {};
        },
        sleep() {
            return Promise.resolve();
        }
    });

    const result = await waitForAssistantResponse(null, 5);
    assert.equal(result, null);
});
