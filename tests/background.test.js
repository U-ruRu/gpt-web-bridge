import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

async function loadBackgroundHelpers() {
    const source = await readFile(join(projectDir, "extension", "background.js"), "utf8");
    const normalizeAgentConfigMatch = source.match(/function normalizeAgentConfig\(value\) \{[\s\S]*?\n\}/);
    const normalizeHttpServerUrlMatch = source.match(/function normalizeHttpServerUrl\(value\) \{[\s\S]*?\n\}/);
    const toAgentWebSocketUrlMatch = source.match(/function toAgentWebSocketUrl\(serverUrl\) \{[\s\S]*?\n\}/);
    const normalizeNullableStringMatch = source.match(/function normalizeNullableString\(value\) \{[\s\S]*?\n\}/);
    const normalizeParallelChatsModeMatch = source.match(/function normalizeParallelChatsMode\(value\) \{[\s\S]*?\n\}/);
    const isPlainObjectMatch = source.match(/function isPlainObject\(value\) \{[\s\S]*?\n\}/);

    assert.ok(normalizeAgentConfigMatch, "normalizeAgentConfig() should be declared in background.js");
    assert.ok(normalizeHttpServerUrlMatch, "normalizeHttpServerUrl() should be declared in background.js");
    assert.ok(toAgentWebSocketUrlMatch, "toAgentWebSocketUrl() should be declared in background.js");
    assert.ok(normalizeNullableStringMatch, "normalizeNullableString() should be declared in background.js");
    assert.ok(normalizeParallelChatsModeMatch, "normalizeParallelChatsMode() should be declared in background.js");
    assert.ok(isPlainObjectMatch, "isPlainObject() should be declared in background.js");

    const module = { exports: {} };
    const factory = new Function(
        "module",
        "exports",
        `"use strict";
        const PARALLEL_CHATS_DEFAULT_MODE = "sequential_safe_timeout";
        ${normalizeNullableStringMatch[0]}
        ${normalizeParallelChatsModeMatch[0]}
        ${isPlainObjectMatch[0]}
        ${normalizeHttpServerUrlMatch[0]}
        ${normalizeAgentConfigMatch[0]}
        ${toAgentWebSocketUrlMatch[0]}
        module.exports = { normalizeAgentConfig, normalizeParallelChatsMode, toAgentWebSocketUrl };`
    );
    factory(module, module.exports);
    return module.exports;
}

async function loadSchedulerHelpers() {
    const source = await readFile(join(projectDir, "extension", "background.js"), "utf8");
    const getParallelChatsModeMatch = source.match(/function getParallelChatsMode\(config\) \{[\s\S]*?\n\}/);
    const isSequentialParallelChatsModeMatch = source.match(/function isSequentialParallelChatsMode\(mode\) \{[\s\S]*?\n\}/);
    const getNextQueuedJobEntryMatch = source.match(/function getNextQueuedJobEntry\(\) \{[\s\S]*?\n\}/);
    const canDispatchQueuedJobMatch = source.match(/function canDispatchQueuedJob\(mode, sessionToken, job\) \{[\s\S]*?\n\}/);
    const markJobDispatchedMatch = source.match(/function markJobDispatched\(mode, sessionToken, job\) \{[\s\S]*?\n\}/);
    const releaseDispatchGateMatch = source.match(/function releaseDispatchGate\(commandId, useSafeDelay\) \{[\s\S]*?\n\}/);
    const resetSchedulerStateMatch = source.match(/function resetSchedulerState\(\) \{[\s\S]*?\n\}/);
    const normalizeParallelChatsModeMatch = source.match(/function normalizeParallelChatsMode\(value\) \{[\s\S]*?\n\}/);
    const randomBetweenMatch = source.match(/function randomBetween\(min, max\) \{[\s\S]*?\n\}/);

    assert.ok(getParallelChatsModeMatch, "getParallelChatsMode() should be declared in background.js");
    assert.ok(isSequentialParallelChatsModeMatch, "isSequentialParallelChatsMode() should be declared in background.js");
    assert.ok(getNextQueuedJobEntryMatch, "getNextQueuedJobEntry() should be declared in background.js");
    assert.ok(canDispatchQueuedJobMatch, "canDispatchQueuedJob() should be declared in background.js");
    assert.ok(markJobDispatchedMatch, "markJobDispatched() should be declared in background.js");
    assert.ok(releaseDispatchGateMatch, "releaseDispatchGate() should be declared in background.js");
    assert.ok(resetSchedulerStateMatch, "resetSchedulerState() should be declared in background.js");
    assert.ok(normalizeParallelChatsModeMatch, "normalizeParallelChatsMode() should be declared in background.js");
    assert.ok(randomBetweenMatch, "randomBetween() should be declared in background.js");

    const module = { exports: {} };
    const factory = new Function(
        "module",
        "exports",
        `"use strict";
        const PARALLEL_CHATS_DEFAULT_MODE = "sequential_safe_timeout";
        const SAFE_TIMEOUT_MIN_MS = 3000;
        const SAFE_TIMEOUT_MAX_MS = 10000;
        let globalSendLock = null;
        let globalSendCooldownUntil = 0;
        const pendingJobs = new Map();
        const dispatchedJobs = new Map();
        ${normalizeParallelChatsModeMatch[0]}
        ${getParallelChatsModeMatch[0]}
        ${isSequentialParallelChatsModeMatch[0]}
        ${getNextQueuedJobEntryMatch[0]}
        ${canDispatchQueuedJobMatch[0]}
        ${markJobDispatchedMatch[0]}
        ${releaseDispatchGateMatch[0]}
        ${resetSchedulerStateMatch[0]}
        ${randomBetweenMatch[0]}
        function setPendingJobs(entries) {
            pendingJobs.clear();
            for (const entry of entries) {
                pendingJobs.set(entry.sessionToken, [...entry.jobs]);
            }
        }
        function getSchedulerState() {
            return {
                globalSendLock,
                globalSendCooldownUntil,
                dispatchedJobs: Array.from(dispatchedJobs.entries())
            };
        }
        module.exports = {
            getParallelChatsMode,
            canDispatchQueuedJob,
            markJobDispatched,
            releaseDispatchGate,
            resetSchedulerState,
            setPendingJobs,
            getSchedulerState
        };`
    );
    factory(module, module.exports);
    return module.exports;
}

async function loadExtensionManifest() {
    const manifestText = await readFile(join(projectDir, "extension", "manifest.json"), "utf8");
    return JSON.parse(manifestText);
}

async function loadPopupHtml() {
    return await readFile(join(projectDir, "extension", "popup.html"), "utf8");
}

test("background normalizes a valid remote agent configuration and defaults to safe sequential mode", async () => {
    const { normalizeAgentConfig, normalizeParallelChatsMode } = await loadBackgroundHelpers();

    assert.deepEqual(
        normalizeAgentConfig({
            serverUrl: " https://bridge.example.com/api/ ",
            serverAccessToken: " server-secret ",
            userToken: " user-secret "
        }),
        {
            serverUrl: "https://bridge.example.com/api",
            serverAccessToken: "server-secret",
            userToken: "user-secret",
            parallelChatsMode: "sequential_safe_timeout"
        }
    );

    assert.deepEqual(
        normalizeAgentConfig({
            serverUrl: "https://bridge.example.com",
            serverAccessToken: "secret",
            userToken: "user",
            parallelChatsMode: "parallel"
        }),
        {
            serverUrl: "https://bridge.example.com",
            serverAccessToken: "secret",
            userToken: "user",
            parallelChatsMode: "parallel"
        }
    );

    assert.equal(normalizeParallelChatsMode("unexpected"), null);
    assert.equal(
        normalizeAgentConfig({
            serverUrl: "ftp://example.com",
            serverAccessToken: "secret",
            userToken: "user"
        }),
        null
    );
});

test("background derives the agent websocket URL from the configured server URL", async () => {
    const { toAgentWebSocketUrl } = await loadBackgroundHelpers();

    assert.equal(
        toAgentWebSocketUrl("https://bridge.example.com"),
        "wss://bridge.example.com/agent/ws"
    );
    assert.equal(
        toAgentWebSocketUrl("http://127.0.0.1:8787/api"),
        "ws://127.0.0.1:8787/api/agent/ws"
    );
});

test("background scheduler honors sequential locking and safe timeout mode", async () => {
    const {
        getParallelChatsMode,
        canDispatchQueuedJob,
        markJobDispatched,
        releaseDispatchGate,
        resetSchedulerState,
        setPendingJobs,
        getSchedulerState
    } = await loadSchedulerHelpers();

    resetSchedulerState();
    setPendingJobs([
        {
            sessionToken: "chat-1",
            jobs: [{ commandId: "cmd-1", sequence: 1 }]
        },
        {
            sessionToken: "chat-2",
            jobs: [{ commandId: "cmd-2", sequence: 2 }]
        }
    ]);

    assert.equal(getParallelChatsMode(null), "sequential_safe_timeout");
    assert.equal(canDispatchQueuedJob("sequential_safe_timeout", "chat-1", { commandId: "cmd-1", sequence: 1 }), true);
    markJobDispatched("sequential_safe_timeout", "chat-1", { commandId: "cmd-1", sequence: 1 });
    assert.equal(canDispatchQueuedJob("sequential_safe_timeout", "chat-2", { commandId: "cmd-2", sequence: 2 }), false);

    const originalRandom = Math.random;
    try {
        Math.random = () => 0;
        releaseDispatchGate("cmd-1", true);
    } finally {
        Math.random = originalRandom;
    }

    const schedulerState = getSchedulerState();
    assert.equal(schedulerState.globalSendLock, null);
    assert.ok(schedulerState.globalSendCooldownUntil >= Date.now() + 2500);
    assert.ok(schedulerState.globalSendCooldownUntil <= Date.now() + 10000);
    assert.equal(canDispatchQueuedJob("parallel", "chat-2", { commandId: "cmd-2", sequence: 2 }), true);
});

test("extension manifest allows browser-agent websocket connections to localhost and secure remotes", async () => {
    const manifest = await loadExtensionManifest();

    const extensionPagesPolicy = manifest.content_security_policy?.extension_pages || "";
    assert.match(extensionPagesPolicy, /connect-src/);
    assert.match(extensionPagesPolicy, /ws:\/\/127\.0\.0\.1:\*/);
    assert.match(extensionPagesPolicy, /http:\/\/127\.0\.0\.1:\*/);
    assert.match(extensionPagesPolicy, /\bhttps:/);
    assert.match(extensionPagesPolicy, /\bwss:/);
    assert.doesNotMatch(extensionPagesPolicy, /upgrade-insecure-requests/);
});

test("extension action exposes a popup with a visible settings button", async () => {
    const manifest = await loadExtensionManifest();
    const popupHtml = await loadPopupHtml();

    assert.equal(manifest.action?.default_popup, "popup.html");
    assert.match(popupHtml, /id="open-settings"/);
    assert.match(popupHtml, /Open Settings/);
});
