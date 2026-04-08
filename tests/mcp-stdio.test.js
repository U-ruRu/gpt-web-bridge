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

test("stdio MCP exposes tools and returns assistant text for ask()", { timeout: 20000 }, async (t) => {
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
        "chatgpt_web.ask",
        "chatgpt_web.new_chat",
        "chatgpt_web.set_temporary"
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

    const askPromise = client.callTool({
        name: "chatgpt_web.ask",
        arguments: {
            request: "Привет из MCP"
        }
    });

    const pendingJob = await waitFor(async () => {
        const response = await fetch(`${bridgeBaseUrl}/session/next?sessionId=${sessionId}`);
        if (response.status === 204) {
            return null;
        }

        return await response.json();
    });

    assert.equal(pendingJob.sessionId, sessionId);
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

    const askResult = await askPromise;
    assert.equal(askResult.content[0].type, "text");
    assert.equal(askResult.content[0].text, "Привет из теста MCP");
    assert.equal(askResult.structuredContent.responseText, "Привет из теста MCP");
    assert.equal(askResult.structuredContent.sessionId, sessionId);

    await sleep(100);
    assert.match(stderrText, /\[mcp\] MCP stdio server is ready for session mcp-stdio-session/);
});
