import test from "node:test";
import assert from "node:assert/strict";
import { ChatGptWebRuntime } from "../dist/bridge/store.js";
import { listenBridgeServer, startBridgeServer } from "../dist/bridge/server.js";
import { cleanupTempDir, createTempDir, sleep } from "./helpers.js";

async function closeServer(server) {
    await new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    });
}

test("HTTP bridge /health and /ask expose the expected contract", { timeout: 15000 }, async (t) => {
    const dataRootDir = await createTempDir();
    t.after(async () => {
        await cleanupTempDir(dataRootDir);
    });

    const runtime = new ChatGptWebRuntime({
        sessionId: "http-session",
        dataRootDir
    });
    await runtime.initialize();

    const server = startBridgeServer(runtime);
    const address = await listenBridgeServer(server, { host: "127.0.0.1", port: 0 });
    t.after(async () => {
        await closeServer(server);
    });

    const healthResponse = await fetch(`${address.baseUrl}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
        ok: true,
        sessionId: "http-session"
    });

    const askResponsePromise = fetch(`${address.baseUrl}/ask`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
            request: "Привет через HTTP",
            waitTimeoutMs: 3000
        })
    });

    await sleep(50);
    const claimedJob = runtime.claimNextJob("http-session");
    assert.ok(claimedJob, "bridge ask should queue a claimable job");

    await runtime.updateJobStatus(claimedJob.id, {
        status: "running",
        detail: "Started by test automation."
    });
    await runtime.updateJobStatus(claimedJob.id, {
        status: "sent",
        detail: "Done.",
        conversationUrl: "https://chatgpt.com/c/http-chat-1",
        responseText: "HTTP ответ"
    });

    const askResponse = await askResponsePromise;
    assert.equal(askResponse.status, 200);
    const askJson = await askResponse.json();
    assert.equal(askJson.responseText, "HTTP ответ");
    assert.equal(askJson.sessionId, "http-session");
    assert.equal(askJson.conversationUrl, "https://chatgpt.com/c/http-chat-1");
});

test("HTTP bridge /debug/state exposes runtime diagnostics", { timeout: 15000 }, async (t) => {
    const dataRootDir = await createTempDir();
    t.after(async () => {
        await cleanupTempDir(dataRootDir);
    });

    const runtime = new ChatGptWebRuntime({
        sessionId: "debug-session",
        dataRootDir
    });
    await runtime.initialize();
    runtime.queueJob("Диагностика");

    const server = startBridgeServer(runtime);
    const address = await listenBridgeServer(server, { host: "127.0.0.1", port: 0 });
    t.after(async () => {
        await closeServer(server);
    });

    const stateResponse = await fetch(`${address.baseUrl}/debug/state`);
    assert.equal(stateResponse.status, 200);
    const stateJson = await stateResponse.json();
    assert.equal(stateJson.session.sessionId, "debug-session");
    assert.equal(stateJson.jobs.length, 1);
    assert.equal(stateJson.jobs[0].text, "Диагностика");
    assert.match(stateJson.paths.sessionLogPath, /debug-session-runtime\.log$/);
});
