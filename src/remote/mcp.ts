import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { RemoteOrchestrator } from "./orchestrator.js";

interface RemoteMcpContext {
    userId: string;
    mcpSessionId: string;
}

const chatSchema = z.number().int().positive().optional().describe("Optional chat number.");
const chatListSchema = z.array(z.number().int().positive()).min(1).optional().describe("Optional list of chat numbers.");

export function createRemoteMcpServer(orchestrator: RemoteOrchestrator, context: RemoteMcpContext) {
    const server = new McpServer({
        name: "chatgpt-web-bridge-remote",
        version: "0.5.0"
    });

    server.registerTool(
        "chatgpt_web.new_chat",
        {
            description: "Open a fresh ChatGPT chat in the user's browser agent.",
            inputSchema: {
                temporary: z.boolean().optional().describe("Open the new chat in temporary mode. Defaults to true."),
                count: z.number().int().positive().optional().describe("How many chats to open. Defaults to 1.")
            }
        },
        async ({ temporary, count }) => {
            const result = await orchestrator.newChat(context.userId, context.mcpSessionId, temporary ?? true, count ?? 1);
            return {
                content: [
                    {
                        type: "text",
                        text: result.chat != null ? `${result.chat}` : JSON.stringify(result.chats || [])
                    }
                ],
                structuredContent: result as unknown as Record<string, unknown>
            };
        }
    );

    server.registerTool(
        "chatgpt_web.ask_async",
        {
            description: "Queue a prompt for a chat and return a persistent message id immediately.",
            inputSchema: {
                request: z.string().trim().min(1).describe("The prompt text to send to ChatGPT."),
                chat: chatSchema
            }
        },
        async ({ request, chat }) => {
            const result = await orchestrator.askAsync(context.userId, context.mcpSessionId, request, chat);
            return {
                content: [
                    {
                        type: "text",
                        text: `${result.chat}:${result.message}`
                    }
                ],
                structuredContent: result as unknown as Record<string, unknown>
            };
        }
    );

    server.registerTool(
        "chatgpt_web.await_response",
        {
            description: "Read the current state of a previously queued message.",
            inputSchema: {
                chat: z.number().int().positive().describe("Chat number."),
                message: z.number().int().positive().describe("Message number returned by chatgpt_web.ask_async.")
            }
        },
        async ({ chat, message }) => {
            const result = await orchestrator.awaitResponse(context.userId, context.mcpSessionId, chat, message);
            return {
                content: [
                    {
                        type: "text",
                        text: result.status === "completed" ? result.response : result.status
                    }
                ],
                structuredContent: result as unknown as Record<string, unknown>
            };
        }
    );

    server.registerTool(
        "chatgpt_web.response_status",
        {
            description: "Return recent chat/message statuses for the current user, or inspect specific chats by number.",
            inputSchema: {
                chats: chatListSchema.describe("Optional list of specific chat numbers to inspect, including older chats.")
            }
        },
        async ({ chats }) => {
            const result = await orchestrator.getResponseStatus(context.userId, context.mcpSessionId, chats);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result)
                    }
                ],
                structuredContent: result as unknown as Record<string, unknown>
            };
        }
    );

    server.registerTool(
        "chatgpt_web.wait",
        {
            description: "Pause for a short amount of time so the client can back off between polling attempts.",
            inputSchema: {
                seconds: z.number().int().min(1).max(110).describe("How long to wait.")
            }
        },
        async ({ seconds }) => {
            await sleep(seconds * 1000);
            return {
                content: [
                    {
                        type: "text",
                        text: `waited ${seconds}`
                    }
                ],
                structuredContent: {
                    waitedSec: seconds
                } as Record<string, unknown>
            };
        }
    );

    server.registerTool(
        "chatgpt_web.release_chat",
        {
            description: "Release a chat and close its automation tab while keeping retained history available.",
            inputSchema: {
                chat: chatSchema,
                chats: chatListSchema
            }
        },
        async ({ chat, chats }) => {
            const result = await orchestrator.releaseChat(context.userId, context.mcpSessionId, chat, chats);
            return {
                content: [
                    {
                        type: "text",
                        text: "ok"
                    }
                ],
                structuredContent: result as unknown as Record<string, unknown>
            };
        }
    );

    return server;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
