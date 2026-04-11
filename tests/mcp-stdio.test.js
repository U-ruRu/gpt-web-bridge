import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanupTempDir, createTempDir, sleep, waitFor } from "./helpers.js";

const projectDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const distEntryPath = join(projectDir, "dist", "index.js");

function extractBridgeBaseUrl(stderrText) {
    const match = stderrText.match(/\[bridge\] Listening on (http:\/\/127\.0\.0\.1:\d+) for session /);
    return match?.[1] || null;
}

test("stdio MCP exposes async-only tools and persists message state", { timeout: 20000 }, async (t) => {
    const dataRootDir = await createTempDir();
    const sessionId = "mcp-stdio-session";
    let stderrText = "";

    t.after(async () => {
        await cleanupTempDir(dataRootDir);
    });

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [distEntryPath, "--transport=stdio", `--session-id=${sessionId}`, `--data-dir=${dataRootDir}`],
        cwd: projectDir,
        stderr: "pipe"
    });

    transport.stderr?.on("data", (chunk) => {
        stderrText += chunk.toString("utf8");
    });

    const client = new Client(
        {
            name: "chatgpt-web-bridge-test-client",
            version: "1.0.0"
        },
        {
            capabilities: {}
        }
    );

    t.after(async () => {
        await Promise.allSettled([
            client.close(),
            transport.close()
        ]);
    });

    await client.connect(transport);
    const bridgeBaseUrl = await waitFor(() => extractBridgeBaseUrl(stderrText), {
        timeoutMs: 5000
    });

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
        "chatgpt_web.ask_async",
        "chatgpt_web.await_response",
        "chatgpt_web.new_chat",
        "chatgpt_web.response_status",
        "chatgpt_web.set_temporary",
        "chatgpt_web.wait"
    ]);

    const temporaryPromise = client.callTool({
        name: "chatgpt_web.set_temporary",
        arguments: {}
    });

    const pendingCommand = await waitFor(async () => {
        const response = await fetch(`${bridgeBaseUrl}/automation/command`);
        if (response.status === 204) {
            return null;
        }

        return await response.json();
    });

    assert.equal(pendingCommand.type, "set-temporary");
    await fetch(`${bridgeBaseUrl}/automation/command/status`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
            token: pendingCommand.token,
            status: "completed",
            detail: "Temporary mode enabled by test."
        })
    });

    const temporaryResult = await temporaryPromise;
    assert.equal(temporaryResult.structuredContent.status, "completed");

    const askAsyncResult = await client.callTool({
        name: "chatgpt_web.ask_async",
        arguments: {
            request: "Привет из MCP",
            chat: 1
        }
    });
    assert.equal(askAsyncResult.structuredContent.chat, 1);
    assert.equal(askAsyncResult.structuredContent.message, 1);
    assert.equal(typeof askAsyncResult.structuredContent.etaMinMs, "number");
    assert.equal(typeof askAsyncResult.structuredContent.etaMaxMs, "number");

    const pendingJob = await waitFor(async () => {
        const response = await fetch(`${bridgeBaseUrl}/session/next?sessionId=${sessionId}`);
        if (response.status === 204) {
            return null;
        }

        return await response.json();
    });

    assert.equal(pendingJob.sessionId, sessionId);
    assert.equal(pendingJob.chat, 1);
    assert.equal(pendingJob.message, 1);

    const pendingStatus = await client.callTool({
        name: "chatgpt_web.await_response",
        arguments: {
            chat: 1,
            message: 1
        }
    });
    assert.deepEqual(pendingStatus.structuredContent.status, "pending");
    assert.equal(pendingStatus.structuredContent.chat, 1);
    assert.equal(pendingStatus.structuredContent.message, 1);
    assert.equal(typeof pendingStatus.structuredContent.elapsedMs, "number");

    await fetch(`${bridgeBaseUrl}/jobs/${pendingJob.id}/status`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
            status: "running",
            detail: "Accepted by MCP test."
        })
    });

    await sleep(20);
    const responseStatusWhileRunning = await client.callTool({
        name: "chatgpt_web.response_status",
        arguments: {}
    });
    assert.equal(responseStatusWhileRunning.structuredContent.defaultChat, 1);
    assert.equal(responseStatusWhileRunning.structuredContent.chats[0].messages[0].status, "pending");

    await fetch(`${bridgeBaseUrl}/jobs/${pendingJob.id}/status`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
            status: "sent",
            detail: "Response captured.",
            conversationUrl: "https://chatgpt.com/c/mcp-chat-1",
            responseText: "Привет из теста MCP"
        })
    });

    const completed = await client.callTool({
        name: "chatgpt_web.await_response",
        arguments: {
            chat: 1,
            message: 1
        }
    });
    assert.equal(completed.content[0].text, "Привет из теста MCP");
    assert.deepEqual(completed.structuredContent, {
        status: "completed",
        chat: 1,
        message: 1,
        response: "Привет из теста MCP",
        read: true
    });

    const responseStatusAfterCompletion = await client.callTool({
        name: "chatgpt_web.response_status",
        arguments: {}
    });
    assert.equal(typeof responseStatusAfterCompletion.structuredContent.averageGenerationMs, "number");
    assert.deepEqual(responseStatusAfterCompletion.structuredContent.chats, [
        {
            chat: 1,
            state: "ready",
            temporary: true,
            messages: [
                {
                    message: 1,
                    status: "completed",
                    read: true,
                    createdAt: responseStatusAfterCompletion.structuredContent.chats[0].messages[0].createdAt,
                    completedAt: responseStatusAfterCompletion.structuredContent.chats[0].messages[0].completedAt,
                    elapsedMs: responseStatusAfterCompletion.structuredContent.chats[0].messages[0].elapsedMs,
                    generationMs: responseStatusAfterCompletion.structuredContent.chats[0].messages[0].generationMs
                }
            ]
        }
    ]);
    assert.equal(typeof responseStatusAfterCompletion.structuredContent.chats[0].messages[0].generationMs, "number");

    const waitResult = await client.callTool({
        name: "chatgpt_web.wait",
        arguments: {
            seconds: 1
        }
    });
    assert.equal(waitResult.content[0].text, "waited 1");
    assert.deepEqual(waitResult.structuredContent, {
        waitedSec: 1
    });

    await sleep(100);
    assert.match(stderrText, /\[mcp\] MCP stdio server is ready for session mcp-stdio-session/);
});
