import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { openExternalUrl } from "../bridge/server.js";
import { ChatGptWebRuntime } from "../bridge/store.js";

interface McpServerContext {
    bridgePort: number;
}

const chatSchema = z.number().int().positive().optional().describe("Optional chat number. In stdio mode only chat 1 exists.");

export async function startStdioMcpServer(runtime: ChatGptWebRuntime, context: McpServerContext) {
    const server = new McpServer({
        name: "chatgpt-web-bridge",
        version: "0.3.0"
    });

    server.registerTool(
        "chatgpt_web.new_chat",
        {
            description: "Open a fresh ChatGPT web chat in the dedicated automation tab and wait until it is ready."
        },
        async () => {
            const result = await runtime.newChat(context.bridgePort, openExternalUrl);
            return {
                content: [
                    {
                        type: "text",
                        text: `Chat is ready for session ${result.sessionId}.`
                    }
                ],
                structuredContent: toStructuredContent(result)
            };
        }
    );

    server.registerTool(
        "chatgpt_web.set_temporary",
        {
            description: "Switch the current dedicated ChatGPT automation tab into temporary chat mode."
        },
        async () => {
            const result = await runtime.setTemporary();
            return {
                content: [
                    {
                        type: "text",
                        text: result.detail || "Temporary chat mode is enabled."
                    }
                ],
                structuredContent: toStructuredContent(result)
            };
        }
    );

    server.registerTool(
        "chatgpt_web.ask_async",
        {
            description: "Queue a prompt for the local ChatGPT chat and return a persistent message id immediately.",
            inputSchema: {
                request: z.string().min(1).describe("The prompt text to send to ChatGPT through the web interface."),
                chat: chatSchema
            }
        },
        async ({ request, chat }) => {
            const result = await runtime.askAsync(request, chat);
            return {
                content: [
                    {
                        type: "text",
                        text: `${result.chat}:${result.message}`
                    }
                ],
                structuredContent: toStructuredContent(result)
            };
        }
    );

    server.registerTool(
        "chatgpt_web.await_response",
        {
            description: "Read the current state of a previously queued message.",
            inputSchema: {
                chat: z.number().int().positive().describe("Chat number. In stdio mode use 1."),
                message: z.number().int().positive().describe("Message number returned by chatgpt_web.ask_async.")
            }
        },
        async ({ chat, message }) => {
            const result = await runtime.awaitResponse(message, chat);
            return {
                content: [
                    {
                        type: "text",
                        text: result.status === "completed" ? result.response : result.status
                    }
                ],
                structuredContent: toStructuredContent(result)
            };
        }
    );

    server.registerTool(
        "chatgpt_web.response_status",
        {
            description: "Return the status of the local chat and its retained message history."
        },
        async () => {
            const result = await runtime.getResponseStatus();
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result)
                    }
                ],
                structuredContent: toStructuredContent(result)
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
                structuredContent: toStructuredContent({
                    waitedSec: seconds
                })
            };
        }
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
    return server;
}

function toStructuredContent(value: unknown) {
    return value as Record<string, unknown>;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
