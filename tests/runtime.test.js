import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ChatGptWebRuntime } from "../dist/bridge/store.js";
import { cleanupTempDir, createTempDir, sleep } from "./helpers.js";

async function createRuntime(t, sessionId = "session-test") {
    const dataRootDir = await createTempDir();
    t.after(async () => {
        await cleanupTempDir(dataRootDir);
    });

    const runtime = new ChatGptWebRuntime({
        sessionId,
        dataRootDir
    });
    await runtime.initialize();
    return { runtime, dataRootDir };
}

test("runtime newChat opens a claimable launch URL and resolves when the launch becomes ready", { timeout: 10000 }, async (t) => {
    const { runtime } = await createRuntime(t, "new-chat-session");
    let openedUrl = null;

    const result = await runtime.newChat(
        43123,
        async (url) => {
            openedUrl = url;
            const token = new URL(url).hash.match(/bridgeClaim=([^&]+)/)?.[1] || null;
            assert.ok(token, "launch URL should contain bridgeClaim");

            setTimeout(() => {
                void runtime.updateAutomationLaunch(token, "ready", "Automation tab is ready.");
            }, 10);
        },
        2000
    );

    assert.ok(openedUrl);
    const parsedUrl = new URL(openedUrl);
    assert.equal(parsedUrl.origin, "https://chatgpt.com");
    assert.equal(parsedUrl.searchParams.has("bridgePort"), false);
    assert.equal(parsedUrl.searchParams.has("bridgeSessionId"), false);
    assert.equal(parsedUrl.hash.includes("bridgeClaim="), true);
    assert.equal(parsedUrl.hash.includes("bridgePort=43123"), true);
    assert.equal(parsedUrl.hash.includes("bridgeSessionId=new-chat-session"), true);
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, "new-chat-session");
    assert.equal(result.status, "ready");
});

test("runtime restoreConversationLaunch keeps the canonical chat URL and stores bridge data in the hash", { timeout: 10000 }, async (t) => {
    const sessionId = "restore-session";
    const conversationUrl = "https://chatgpt.com/c/69d34509-fc88-8391-a2ee-ba71df5a462b";
    const { runtime, dataRootDir } = await createRuntime(t, sessionId);

    const askPromise = runtime.ask("Запомни этот чат.", 2000);
    await sleep(50);

    const job = runtime.claimNextJob(sessionId);
    assert.ok(job, "the queued job should be claimable");

    await runtime.updateJobStatus(job.id, {
        status: "running",
        detail: "Processing request."
    });
    await runtime.updateJobStatus(job.id, {
        status: "sent",
        detail: "Completed.",
        conversationUrl,
        responseText: "Запомнил."
    });
    await askPromise;

    const restoredRuntime = new ChatGptWebRuntime({
        sessionId,
        dataRootDir
    });
    await restoredRuntime.initialize();

    let openedUrl = null;
    const launch = await restoredRuntime.restoreConversationLaunch(
        43123,
        async (url) => {
            openedUrl = url;
            const token = new URL(url).hash.match(/bridgeClaim=([^&]+)/)?.[1];
            assert.ok(token, "restore URL should contain bridgeClaim in the hash");

            setTimeout(() => {
                void restoredRuntime.updateAutomationLaunch(token, "ready", "Existing chat is ready.");
            }, 10);
        },
        2000
    );

    assert.ok(openedUrl);
    const parsedUrl = new URL(openedUrl);
    assert.equal(`${parsedUrl.origin}${parsedUrl.pathname}`, conversationUrl);
    assert.equal(parsedUrl.search, "");
    assert.equal(parsedUrl.hash.includes("bridgeClaim="), true);
    assert.equal(parsedUrl.hash.includes("bridgePort=43123"), true);
    assert.equal(parsedUrl.hash.includes(`bridgeSessionId=${sessionId}`), true);
    assert.equal(launch?.status, "ready");
});

test("runtime setTemporary waits for the pending automation command and switches the session mode", { timeout: 10000 }, async (t) => {
    const { runtime } = await createRuntime(t, "temporary-session");

    const pendingResult = runtime.setTemporary(2000);
    await sleep(50);
    const command = runtime.getPendingAutomationCommand();

    assert.ok(command, "a pending automation command should exist");
    assert.equal(command.type, "set-temporary");

    await runtime.updateAutomationCommand(command.token, "completed", "Temporary mode enabled.");
    const result = await pendingResult;

    assert.equal(result.ok, true);
    assert.equal(result.status, "completed");
    assert.equal(runtime.getSessionView().mode, "temporary");
});

test("runtime ask persists the conversation and writes escaped UTF-8 chat history", { timeout: 10000 }, async (t) => {
    const sessionId = "history-session";
    const { runtime, dataRootDir } = await createRuntime(t, sessionId);
    const requestText = "Привет \"мир\"\nещё строка";
    const responseText = "Ответ \"мир\"\nстрока 2";
    const conversationUrl = "https://chatgpt.com/c/chat-123";

    const askPromise = runtime.ask(requestText, 2000);
    await sleep(50);

    const job = runtime.claimNextJob(sessionId);
    assert.ok(job, "the queued job should be claimable");
    assert.equal(job.text, requestText);

    await runtime.updateJobStatus(job.id, {
        status: "running",
        detail: "Processing request."
    });
    await runtime.updateJobStatus(job.id, {
        status: "sent",
        detail: "Completed.",
        conversationUrl,
        responseText
    });

    const result = await askPromise;
    assert.equal(result.status, "sent");
    assert.equal(result.responseText, responseText);
    assert.equal(result.conversationUrl, conversationUrl);

    const historyPath = join(dataRootDir, "chat-history", `${sessionId}-chat-123-chatHistory.log`);
    const historyContent = await readFile(historyPath, "utf8");
    assert.equal(
        historyContent,
        'Request: "Привет \\"мир\\"\\nещё строка"\nAnswer: "Ответ \\"мир\\"\\nстрока 2"\n'
    );

    const restoredRuntime = new ChatGptWebRuntime({
        sessionId,
        dataRootDir
    });
    await restoredRuntime.initialize();
    assert.equal(restoredRuntime.hasRestorableConversation(), true);
    assert.equal(restoredRuntime.getRestorableConversationUrl(), conversationUrl);
    assert.equal(restoredRuntime.getSessionView().targetUrl, conversationUrl);
});
