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
    const sessionModes = new Map();

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
        receivedMessages.push({
            receivedAt: Date.now(),
            message
        });

        if (message.type === "ping") {
            socket.send(JSON.stringify({
                type: "pong",
                timestamp: message.timestamp
            }));
            return;
        }

        if (message.type === "session.start") {
            sessionModes.set(message.sessionToken, "normal");
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

        if (message.type === "session.setTemporary") {
            sessionModes.set(message.sessionToken, "temporary");
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

        if (message.type === "session.ask") {
            const mode = sessionModes.get(message.sessionToken) || "normal";
            setTimeout(() => {
                socket.send(JSON.stringify({
                    type: "session.askAccepted",
                    commandId: message.commandId,
                    sessionToken: message.sessionToken,
                    detail: "Prompt was sent.",
                    conversationUrl: `https://chatgpt.com/c/${message.sessionToken}`,
                    mode
                }));
            }, 20);

            setTimeout(() => {
                socket.send(JSON.stringify({
                    type: "session.askResult",
                    commandId: message.commandId,
                    sessionToken: message.sessionToken,
                    detail: "Assistant response captured.",
                    responseText: `reply:${message.request}`,
                    conversationUrl: `https://chatgpt.com/c/${message.sessionToken}`,
                    mode
                }));
            }, 60);
            return;
        }

        if (message.type === "session.release") {
            sessionModes.delete(message.sessionToken);
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

async function withRemoteServer(t, callback) {
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
        return agent.receivedMessages.find((entry) => entry.message.type === "agent.ready") || null;
    }, {
        timeoutMs: 5000,
        intervalMs: 50
    });

    const first = await createMcpClient(baseUrl, serverAccessToken, userToken);
    t.after(async () => {
        await Promise.allSettled([
            first.client.close(),
            first.transport.close()
        ]);
    });

    await callback({
        agent,
        baseUrl,
        child,
        first,
        serverAccessToken,
        userToken
    });
}

test("remote server exposes simplified chat tools and reuses freed chat numbers", { timeout: 30000 }, async (t) => {
    await withRemoteServer(t, async ({ agent, first }) => {
        const tools = await first.client.listTools();
        assert.deepEqual(
            tools.tools.map((tool) => tool.name).sort(),
            [
                "chatgpt_web.ask",
                "chatgpt_web.ask_async",
                "chatgpt_web.await_response",
                "chatgpt_web.new_chat",
                "chatgpt_web.release_chat",
                "chatgpt_web.session_info"
            ]
        );

        const firstChatStartedAt = Date.now();
        const firstChat = await first.client.callTool({
            name: "chatgpt_web.new_chat",
            arguments: {}
        });
        assert.equal(firstChat.content[0].text, "1");
        assert.deepEqual(firstChat.structuredContent, { chat: 1 });

        const startMessage = agent.receivedMessages.find((entry) => entry.message.type === "session.start");
        const temporaryMessage = agent.receivedMessages.find((entry) => entry.message.type === "session.setTemporary");
        assert.ok(startMessage, "new_chat() should open a chat tab");
        assert.ok(temporaryMessage, "new_chat() should enable temporary mode by default");
        assert.ok(temporaryMessage.receivedAt - firstChatStartedAt >= 2900);

        const secondChat = await first.client.callTool({
            name: "chatgpt_web.new_chat",
            arguments: {
                temporary: false
            }
        });
        assert.equal(secondChat.content[0].text, "2");
        assert.deepEqual(secondChat.structuredContent, { chat: 2 });

        const askAsync = await first.client.callTool({
            name: "chatgpt_web.ask_async",
            arguments: {
                chat: 1,
                request: "hello from first"
            }
        });
        assert.equal(askAsync.content[0].text, "1");
        assert.deepEqual(askAsync.structuredContent, { chat: 1 });

        const duplicateAsk = await first.client.callTool({
            name: "chatgpt_web.ask",
            arguments: {
                chat: 1,
                request: "should fail"
            }
        });
        assert.equal(duplicateAsk.isError, true);
        assert.match(duplicateAsk.content[0].text, /active request|unfinished request|409/i);

        const sessionInfo = await first.client.callTool({
            name: "chatgpt_web.session_info",
            arguments: {}
        });
        assert.deepEqual(sessionInfo.structuredContent, {
            defaultChat: 2,
            chats: [
                {
                    chat: 1,
                    state: "waiting_response",
                    temporary: true
                },
                {
                    chat: 2,
                    state: "ready",
                    temporary: false
                }
            ]
        });

        const response = await first.client.callTool({
            name: "chatgpt_web.await_response",
            arguments: {
                chat: 1
            }
        });
        assert.equal(response.content[0].text, "reply:hello from first");
        assert.deepEqual(response.structuredContent, {
            response: "reply:hello from first"
        });

        const release = await first.client.callTool({
            name: "chatgpt_web.release_chat",
            arguments: {
                chat: 1
            }
        });
        assert.equal(release.content[0].text, "ok");
        assert.deepEqual(release.structuredContent, {
            ok: true
        });

        const reusedChat = await first.client.callTool({
            name: "chatgpt_web.new_chat",
            arguments: {
                temporary: false
            }
        });
        assert.equal(reusedChat.content[0].text, "1");
        assert.deepEqual(reusedChat.structuredContent, { chat: 1 });
    });
});

test("remote server keeps chats alive after an MCP transport session closes", { timeout: 30000 }, async (t) => {
    await withRemoteServer(t, async ({ baseUrl, child, serverAccessToken, userToken, first }) => {
        const openedChat = await first.client.callTool({
            name: "chatgpt_web.new_chat",
            arguments: {
                temporary: false
            }
        });
        assert.deepEqual(openedChat.structuredContent, { chat: 1 });

        await Promise.allSettled([
            first.client.close(),
            first.transport.close()
        ]);

        await waitFor(() => (child.exitCode === null ? true : null), {
            timeoutMs: 5000,
            intervalMs: 50
        });

        const second = await createMcpClient(baseUrl, serverAccessToken, userToken);
        t.after(async () => {
            await Promise.allSettled([
                second.client.close(),
                second.transport.close()
            ]);
        });

        const sessionInfo = await second.client.callTool({
            name: "chatgpt_web.session_info",
            arguments: {}
        });
        assert.deepEqual(sessionInfo.structuredContent, {
            defaultChat: null,
            chats: [
                {
                    chat: 1,
                    state: "ready",
                    temporary: false
                }
            ]
        });
    });
});
