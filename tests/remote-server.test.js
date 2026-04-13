import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { cleanupTempDir, createTempDir, waitFor } from "./helpers.js";

const projectDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const distEntryPath = join(projectDir, "dist", "index.js");
const USER_TOKEN_HEADER = "x-chatgpt-web-bridge-user-token";

function extractServerBaseUrl(stderrText) {
    const match = stderrText.match(/\[server\] Listening on (http:\/\/127\.0\.0\.1:\d+)/);
    return match?.[1] || null;
}

function getRemoteChatPath(dataRootDir, userToken, chatNumber) {
    const userId = createHash("sha256").update(userToken).digest("hex");
    return join(dataRootDir, "remote", "message-store", "remote", "owners", userId, `chat-${chatNumber}.json`);
}

async function rewritePersistedRemoteChat(dataRootDir, userToken, chatNumber, transform) {
    const chatPath = getRemoteChatPath(dataRootDir, userToken, chatNumber);
    const raw = await readFile(chatPath, "utf8");
    const chat = JSON.parse(raw);
    const nextChat = transform(chat);
    await writeFile(chatPath, `${JSON.stringify(nextChat, null, 2)}\n`, "utf8");
}

function createAgentClient(baseUrl, serverAccessToken, userToken, options = {}) {
    const websocketUrl = `${baseUrl.replace(/^http/, "ws")}/agent/ws`;
    const socket = new WebSocket(websocketUrl);
    const receivedMessages = [];
    const sessionModes = new Map();
    const askAcceptedDelayMs = options.askAcceptedDelayMs ?? 20;
    const askResultDelayMs = options.askResultDelayMs ?? 120;

    socket.on("open", () => {
        socket.send(JSON.stringify({
            type: "agent.hello",
            serverAccessToken,
            userToken,
            browserName: "test-agent",
            browserVersion: "1.0.0",
            ...(options.temporaryModeDelaySeconds !== undefined ? { temporaryModeDelaySeconds: options.temporaryModeDelaySeconds } : {})
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
            }, askAcceptedDelayMs);

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
            }, askResultDelayMs);
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

async function withRemoteServer(t, callback, options = {}) {
    const serverAccessToken = "test-server-access-token";
    const userToken = "user-alpha";
    const dataRootDir = await createTempDir();
    let stderrText = "";

    t.after(async () => {
        await cleanupTempDir(dataRootDir);
    });

    const child = spawn(process.execPath, [
        distEntryPath,
        "--transport=server",
        "--host=127.0.0.1",
        "--port=0",
        `--server-access-token=${serverAccessToken}`,
        `--data-dir=${dataRootDir}`
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

    const agent = createAgentClient(baseUrl, serverAccessToken, userToken, options.agentOptions);
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
        dataRootDir,
        first,
        serverAccessToken,
        userToken
    });
}

test("remote server exposes async-only chat tools and durable message status", { timeout: 30000 }, async (t) => {
    await withRemoteServer(t, async ({ agent, first }) => {
        const tools = await first.client.listTools();
        assert.deepEqual(
            tools.tools.map((tool) => tool.name).sort(),
            [
                "chatgpt_web.ask_async",
                "chatgpt_web.await_response",
                "chatgpt_web.new_chat",
                "chatgpt_web.release_chat",
                "chatgpt_web.response_status",
                "chatgpt_web.wait"
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
        const temporaryMessage = await waitFor(() => {
            return agent.receivedMessages.find((entry) => entry.message.type === "session.setTemporary") || null;
        }, {
            timeoutMs: 10000,
            intervalMs: 50
        });
        assert.ok(startMessage, "new_chat() should open a chat tab");
        assert.ok(temporaryMessage, "new_chat() should enable temporary mode by default");
        assert.ok(temporaryMessage.receivedAt - firstChatStartedAt >= 4900);

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
        assert.equal(askAsync.structuredContent.chat, 1);
        assert.equal(askAsync.structuredContent.message, 1);
        assert.equal(typeof askAsync.structuredContent.etaMinMs, "number");
        assert.equal(typeof askAsync.structuredContent.etaMaxMs, "number");

        const duplicateAsk = await first.client.callTool({
            name: "chatgpt_web.ask_async",
            arguments: {
                chat: 1,
                request: "should fail"
            }
        });
        assert.equal(duplicateAsk.isError, true);
        assert.match(duplicateAsk.content[0].text, /active request|unfinished request|409/i);

        const pendingResponse = await first.client.callTool({
            name: "chatgpt_web.await_response",
            arguments: {
                chat: 1,
                message: 1
            }
        });
        assert.equal(pendingResponse.structuredContent.status, "pending");
        assert.equal(typeof pendingResponse.structuredContent.elapsedMs, "number");

        const responseStatusWhilePending = await waitFor(async () => {
            const responseStatus = await first.client.callTool({
                name: "chatgpt_web.response_status",
                arguments: {}
            });
            return responseStatus.structuredContent.chats[0].messages[0].status === "pending" ? responseStatus : null;
        }, {
            timeoutMs: 5000,
            intervalMs: 50
        });

        assert.deepEqual(responseStatusWhilePending.structuredContent, {
            defaultChat: 2,
            averageGenerationMs: null,
            chats: [
                {
                    chat: 1,
                    state: "waiting_response",
                    temporary: true,
                    messages: [
                        {
                            message: 1,
                            status: "pending",
                            read: false,
                            createdAt: responseStatusWhilePending.structuredContent.chats[0].messages[0].createdAt,
                            completedAt: null,
                            elapsedMs: responseStatusWhilePending.structuredContent.chats[0].messages[0].elapsedMs,
                            generationMs: null
                        }
                    ]
                },
                {
                    chat: 2,
                    state: "ready",
                    temporary: false,
                    messages: []
                }
            ]
        });

        const completed = await waitFor(async () => {
            const response = await first.client.callTool({
                name: "chatgpt_web.await_response",
                arguments: {
                    chat: 1,
                    message: 1
                }
            });
            return response.structuredContent.status === "completed" ? response : null;
        }, {
            timeoutMs: 5000,
            intervalMs: 50
        });
        assert.equal(completed.content[0].text, "reply:hello from first");
        assert.deepEqual(completed.structuredContent, {
            status: "completed",
            chat: 1,
            message: 1,
            response: "reply:hello from first",
            read: true
        });

        const responseStatusAfterCompletion = await first.client.callTool({
            name: "chatgpt_web.response_status",
            arguments: {}
        });
        assert.equal(typeof responseStatusAfterCompletion.structuredContent.averageGenerationMs, "number");
        assert.equal(responseStatusAfterCompletion.structuredContent.chats[0].state, "ready");
        assert.equal(responseStatusAfterCompletion.structuredContent.chats[0].messages[0].status, "completed");
        assert.equal(responseStatusAfterCompletion.structuredContent.chats[0].messages[0].read, true);
        assert.equal(typeof responseStatusAfterCompletion.structuredContent.chats[0].messages[0].generationMs, "number");

        const waitResult = await first.client.callTool({
            name: "chatgpt_web.wait",
            arguments: {
                seconds: 1
            }
        });
        assert.equal(waitResult.content[0].text, "waited 1");
        assert.deepEqual(waitResult.structuredContent, {
            waitedSec: 1
        });
    });
});

test("remote server can open and release multiple chats without reusing chat numbers", { timeout: 30000 }, async (t) => {
    await withRemoteServer(t, async ({ first }) => {
        const openedChats = await first.client.callTool({
            name: "chatgpt_web.new_chat",
            arguments: {
                count: 3,
                temporary: false
            }
        });
        assert.equal(openedChats.content[0].text, "[1,2,3]");
        assert.deepEqual(openedChats.structuredContent, {
            chats: [1, 2, 3]
        });

        const responseStatusBeforeRelease = await first.client.callTool({
            name: "chatgpt_web.response_status",
            arguments: {}
        });
        assert.deepEqual(responseStatusBeforeRelease.structuredContent, {
            defaultChat: 3,
            averageGenerationMs: null,
            chats: [
                { chat: 1, state: "ready", temporary: false, messages: [] },
                { chat: 2, state: "ready", temporary: false, messages: [] },
                { chat: 3, state: "ready", temporary: false, messages: [] }
            ]
        });

        const releaseChats = await first.client.callTool({
            name: "chatgpt_web.release_chat",
            arguments: {
                chats: [1, 3]
            }
        });
        assert.equal(releaseChats.content[0].text, "ok");
        assert.deepEqual(releaseChats.structuredContent, {
            ok: true
        });

        const responseStatusAfterRelease = await first.client.callTool({
            name: "chatgpt_web.response_status",
            arguments: {}
        });
        assert.deepEqual(responseStatusAfterRelease.structuredContent, {
            defaultChat: null,
            averageGenerationMs: null,
            chats: [
                { chat: 1, state: "released", temporary: false, messages: [] },
                { chat: 2, state: "ready", temporary: false, messages: [] },
                { chat: 3, state: "released", temporary: false, messages: [] }
            ]
        });

        const nextChat = await first.client.callTool({
            name: "chatgpt_web.new_chat",
            arguments: {
                temporary: false
            }
        });
        assert.deepEqual(nextChat.structuredContent, { chat: 4 });
    }, {
        agentOptions: {
            temporaryModeDelaySeconds: 0
        }
    });
});

test("response_status shows only chats from the last hour unless specific chats are requested", { timeout: 30000 }, async (t) => {
    await withRemoteServer(t, async ({ dataRootDir, first, userToken }) => {
        await first.client.callTool({
            name: "chatgpt_web.new_chat",
            arguments: {
                count: 2,
                temporary: false
            }
        });

        const oldTimestamp = new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString();
        await rewritePersistedRemoteChat(dataRootDir, userToken, 1, (chat) => ({
            ...chat,
            createdAt: oldTimestamp,
            updatedAt: oldTimestamp
        }));

        const recentOnlyStatus = await first.client.callTool({
            name: "chatgpt_web.response_status",
            arguments: {}
        });
        assert.deepEqual(recentOnlyStatus.structuredContent, {
            defaultChat: 2,
            averageGenerationMs: null,
            chats: [
                { chat: 2, state: "ready", temporary: false, messages: [] }
            ]
        });

        const specificChatStatus = await first.client.callTool({
            name: "chatgpt_web.response_status",
            arguments: {
                chats: [1]
            }
        });
        assert.deepEqual(specificChatStatus.structuredContent, {
            defaultChat: 2,
            averageGenerationMs: null,
            chats: [
                { chat: 1, state: "ready", temporary: false, messages: [] }
            ]
        });
    }, {
        agentOptions: {
            temporaryModeDelaySeconds: 0
        }
    });
});

test("remote server keeps released history and chats after an MCP transport session closes", { timeout: 30000 }, async (t) => {
    await withRemoteServer(t, async ({ baseUrl, child, serverAccessToken, userToken, first }) => {
        const openedChat = await first.client.callTool({
            name: "chatgpt_web.new_chat",
            arguments: {
                temporary: false
            }
        });
        assert.deepEqual(openedChat.structuredContent, { chat: 1 });

        const askAsync = await first.client.callTool({
            name: "chatgpt_web.ask_async",
            arguments: {
                chat: 1,
                request: "persist me"
            }
        });
        assert.deepEqual(askAsync.structuredContent.chat, 1);
        assert.deepEqual(askAsync.structuredContent.message, 1);

        await waitFor(async () => {
            const completed = await first.client.callTool({
                name: "chatgpt_web.await_response",
                arguments: {
                    chat: 1,
                    message: 1
                }
            });
            return completed.structuredContent.status === "completed" ? true : null;
        }, {
            timeoutMs: 5000,
            intervalMs: 50
        });

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

        const responseStatus = await second.client.callTool({
            name: "chatgpt_web.response_status",
            arguments: {}
        });
        assert.equal(responseStatus.structuredContent.defaultChat, null);
        assert.deepEqual(responseStatus.structuredContent.chats, [
            {
                chat: 1,
                state: "ready",
                temporary: false,
                messages: [
                    {
                        message: 1,
                        status: "completed",
                        read: true,
                        createdAt: responseStatus.structuredContent.chats[0].messages[0].createdAt,
                        completedAt: responseStatus.structuredContent.chats[0].messages[0].completedAt,
                        elapsedMs: responseStatus.structuredContent.chats[0].messages[0].elapsedMs,
                        generationMs: responseStatus.structuredContent.chats[0].messages[0].generationMs
                    }
                ]
            }
        ]);
    }, {
        agentOptions: {
            temporaryModeDelaySeconds: 0
        }
    });
});
