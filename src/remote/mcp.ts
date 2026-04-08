import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { RemoteOrchestrator } from "./orchestrator.js";

interface RemoteMcpContext {
    userId: string;
    mcpSessionId: string;
}

const chatSchema = z.number().int().positive().optional().describe("Optional chat number.");

export function createRemoteMcpServer(orchestrator: RemoteOrchestrator, context: RemoteMcpContext) {
    const server = new McpServer({
        name: "chatgpt-web-bridge-remote",
        version: "0.4.0"
    });

    server.registerTool(
        "chatgpt_web.new_chat",
        {
            description: "Open a fresh ChatGPT chat in the user's browser agent.",
            inputSchema: {
                temporary: z.boolean().optional().describe("Open the new chat in temporary mode. Defaults to true.")
            }
        },
        async ({ temporary }) => {
            const result = await orchestrator.newChat(context.userId, context.mcpSessionId, temporary ?? true);
            return {
                content: [
                    {
                        type: "text",
                        text: `${result.chat}`
                    }
                ],
                structuredContent: result as unknown as Record<string, unknown>
            };
        }
    );

    server.registerTool(
        "chatgpt_web.ask",
        {
            description: "Send a prompt to a chat and wait for the assistant response.",
            inputSchema: {
                request: z.string().trim().min(1).describe("The prompt text to send to ChatGPT."),
                chat: chatSchema
            }
        },
        async ({ request, chat }) => {
            const result = await orchestrator.ask(context.userId, context.mcpSessionId, request, chat);
            return {
                content: [
                    {
                        type: "text",
                        text: result.response
                    }
                ],
                structuredContent: result as unknown as Record<string, unknown>
            };
        }
    );

    server.registerTool(
        "chatgpt_web.ask_async",
        {
            description: "Send a prompt to a chat and return after the prompt is accepted by ChatGPT.",
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
                        text: `${result.chat}`
                    }
                ],
                structuredContent: result as unknown as Record<string, unknown>
            };
        }
    );

    server.registerTool(
        "chatgpt_web.await_response",
        {
            description: "Wait for the assistant response for a chat that already has an active request.",
            inputSchema: {
                chat: chatSchema
            }
        },
        async ({ chat }) => {
            const result = await orchestrator.awaitResponse(context.userId, context.mcpSessionId, chat);
            return {
                content: [
                    {
                        type: "text",
                        text: result.response
                    }
                ],
                structuredContent: result as unknown as Record<string, unknown>
            };
        }
    );

    server.registerTool(
        "chatgpt_web.release_chat",
        {
            description: "Release a chat and close its automation tab.",
            inputSchema: {
                chat: chatSchema
            }
        },
        async ({ chat }) => {
            const result = await orchestrator.releaseChat(context.userId, context.mcpSessionId, chat);
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

    server.registerTool(
        "chatgpt_web.session_info",
        {
            description: "Return the default chat and the status of all active chats for the current user."
        },
        async () => {
            const result = orchestrator.getSessionInfo(context.userId, context.mcpSessionId);
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

    return server;
}
