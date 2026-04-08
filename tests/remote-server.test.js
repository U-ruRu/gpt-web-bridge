import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { waitFor } from "./helpers.js";

const projectDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const distEntryPath = join(projectDir, "dist", "index.js");
const USER_TOKEN_HEADER = "x-chatgpt-web-bridge-user-token";

function extractServerBaseUrl(stderrText) {
    const match = stderrText.match(/\[server\] Listening on (http:\/\/127\.0\.0\.1:\d+)/);
    return match?.[1] || null;
}

function createAgentClient(baseUrl, serverAccessToken, userToken) {
    const websocketUrl = `${baseUrl.replace(/^http/, "ws")}/agent/ws`;
    const socket = new WebSocket(websocketUrl);
    const receivedMessages = [];

    socket.on("open", () => {
        socket.send(JSON.stringify({
            type: "agent.hello",
            serverAccessToken,
            userToken,
            browserName: "test-agent",
            browserVersion: "1.0.0"
        }));
    });

    socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        receivedMessages.push(message);

        if (message.type === "ping") {
            socket.send(JSON.stringify({
                type: "pong",
                timestamp: message.timestamp
            }));
            return;
        }

        if (message.type === "session.start") {
            setTimeout(() => {
                socket.send(JSON.stringify({
                    type: "session.ready",
                    commandId: message.commandId,
                    sessionToken: message.sessionToken,
                    detail: "Session is ready.",
                    conversationUrl: null,
                    mode: "normal"
                }));
            }, 20);
            return;
        }

        if (message.type === "session.ask") {
            setTimeout(() => {
                socket.send(JSON.stringify({
                    type: "session.askResult",
                    commandId: message.commandId,
                    sessionToken: message.sessionToken,
                    detail: "Assistant response captured.",
                    responseText: `reply:${message.sessionToken}:${message.request}`,
                    conversationUrl: `https://chatgpt.com/c/${message.sessionToken}`,
                    mode: "normal"
                }));
            }, 20);
            return;
        }

        if (message.type === "session.setTemporary") {
            setTimeout(() => {
                socket.send(JSON.stringify({
                    type: "session.commandResult",
                    commandId: message.commandId,
                    sessionToken: message.sessionToken,
                    detail: "Temporary chat mode is enabled.",
                    mode: "temporary"
                }));
            }, 20);
            return;
        }

        if (message.type === "session.release") {
            setTimeout(() => {
                socket.send(JSON.stringify({
                    type: "session.released",
                    commandId: message.commandId,
                    sessionToken: message.sessionToken,
                    detail: "Session was released."
                }));
            }, 20);
        }
    });

    return {
        socket,
        receivedMessages
    };
}

async function createMcpClient(baseUrl, serverAccessToken, userToken) {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: {
            headers: {
                Authorization: `Bearer ${serverAccessToken}`,
                [USER_TOKEN_HEADER]: userToken
            }
        }
    });
    const client = new Client(
        {
            name: "chatgpt-web-bridge-remote-test-client",
            version: "1.0.0"
        },
        {
            capabilities: {}
        }
    );
    await client.connect(transport);
    return {
        client,
        transport
    };
}

test("remote server isolates chat sessions across MCP transport sessions for the same user", { timeout: 30000 }, async (t) => {
    const serverAccessToken = "test-server-access-token";
    const userToken = "user-alpha";
    let stderrText = "";

    const child = spawn(process.execPath, [
        distEntryPath,
        "--transport=server",
        "--host=127.0.0.1",
        "--port=0",
        `--server-access-token=${serverAccessToken}`
    ], {
        cwd: projectDir,
        stdio: ["ignore", "ignore", "pipe"]
    });

    child.stderr.on("data", (chunk) => {
        stderrText += chunk.toString("utf8");
    });

    t.after(async () => {
        child.kill();
    });

    const baseUrl = await waitFor(() => extractServerBaseUrl(stderrText), {
        timeoutMs: 10000,
        intervalMs: 100
    });

    const agent = createAgentClient(baseUrl, serverAccessToken, userToken);
    t.after(async () => {
        agent.socket.close();
    });

    await waitFor(() => {
        return agent.receivedMessages.find((message) => message.type === "agent.ready") || null;
    }, {
        timeoutMs: 5000,
        intervalMs: 50
    });

    const first = await createMcpClient(baseUrl, serverAccessToken, userToken);
    const second = await createMcpClient(baseUrl, serverAccessToken, userToken);

    t.after(async () => {
        await Promise.allSettled([
            first.client.close(),
            first.transport.close(),
            second.client.close(),
            second.transport.close()
        ]);
    });

    const tools = await first.client.listTools();
    assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        [
            "chatgpt_web.ask",
            "chatgpt_web.new_chat",
            "chatgpt_web.release_session",
            "chatgpt_web.session_info",
            "chatgpt_web.set_temporary"
        ]
    );

    const firstSession = await first.client.callTool({
        name: "chatgpt_web.new_chat",
        arguments: {}
    });
    const secondSession = await second.client.callTool({
        name: "chatgpt_web.new_chat",
        arguments: {}
    });

    const firstSessionToken = firstSession.structuredContent.sessionToken;
    const secondSessionToken = secondSession.structuredContent.sessionToken;
    assert.ok(firstSessionToken);
    assert.ok(secondSessionToken);
    assert.notEqual(firstSessionToken, secondSessionToken);

    const firstAsk = await first.client.callTool({
        name: "chatgpt_web.ask",
        arguments: {
            request: "hello from first"
        }
    });
    const secondAsk = await second.client.callTool({
        name: "chatgpt_web.ask",
        arguments: {
            request: "hello from second"
        }
    });

    assert.equal(firstAsk.content[0].text, `reply:${firstSessionToken}:hello from first`);
    assert.equal(secondAsk.content[0].text, `reply:${secondSessionToken}:hello from second`);

    const temporaryResult = await first.client.callTool({
        name: "chatgpt_web.set_temporary",
        arguments: {}
    });
    assert.equal(temporaryResult.structuredContent.mode, "temporary");

    const sessionInfo = await first.client.callTool({
        name: "chatgpt_web.session_info",
        arguments: {}
    });
    assert.equal(sessionInfo.structuredContent.sessionToken, firstSessionToken);
    assert.equal(sessionInfo.structuredContent.mode, "temporary");

    const releaseResult = await first.client.callTool({
        name: "chatgpt_web.release_session",
        arguments: {}
    });
    assert.equal(releaseResult.structuredContent.sessionToken, firstSessionToken);
});
