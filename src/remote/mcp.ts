import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { RemoteOrchestrator } from "./orchestrator.js";

interface RemoteMcpContext {
    userId: string;
    mcpSessionId: string;
}

export function createRemoteMcpServer(orchestrator: RemoteOrchestrator, context: RemoteMcpContext) {
    const server = new McpServer({
        name: "chatgpt-web-bridge-remote",
        version: "0.3.0"
    });

    server.registerTool(
        "chatgpt_web.new_chat",
        {
            description: "Open a fresh ChatGPT web chat in the user's browser agent and bind it to the current session.",
            inputSchema: {
                sessionToken: z.string().trim().min(1).optional().describe("Optional explicit chat session token.")
            }
        },
        async ({ sessionToken }) => {
            const result = await orchestrator.newChat(context.userId, context.mcpSessionId, sessionToken);
            return {
                content: [
                    {
                        type: "text",
                        text: `Chat session ${result.sessionToken} is ready.`
                    }
                ],
                structuredContent: result as unknown as Record<string, unknown>
            };
        }
    );

    server.registerTool(
        "chatgpt_web.ask",
        {
            description: "Send a prompt to a bound ChatGPT browser session and return the assistant text.",
            inputSchema: {
                request: z.string().trim().min(1).describe("The prompt text to send to ChatGPT."),
                sessionToken: z.string().trim().min(1).optional().describe("Optional explicit chat session token.")
            }
        },
        async ({ request, sessionToken }) => {
            const result = await orchestrator.ask(context.userId, context.mcpSessionId, request, sessionToken);
            return {
                content: [
                    {
                        type: "text",
                        text: result.responseText
                    }
                ],
                structuredContent: result as unknown as Record<string, unknown>
            };
        }
    );

    server.registerTool(
        "chatgpt_web.set_temporary",
        {
            description: "Switch a bound ChatGPT browser session into temporary chat mode.",
            inputSchema: {
                sessionToken: z.string().trim().min(1).optional().describe("Optional explicit chat session token.")
            }
        },
        async ({ sessionToken }) => {
            const result = await orchestrator.setTemporary(context.userId, context.mcpSessionId, sessionToken);
            return {
                content: [
                    {
                        type: "text",
                        text: result.detail || "Temporary chat mode is enabled."
                    }
                ],
                structuredContent: result as unknown as Record<string, unknown>
            };
        }
    );

    server.registerTool(
        "chatgpt_web.release_session",
        {
            description: "Release a bound browser chat session and close its automation tab.",
            inputSchema: {
                sessionToken: z.string().trim().min(1).optional().describe("Optional explicit chat session token.")
            }
        },
        async ({ sessionToken }) => {
            const result = await orchestrator.releaseSession(context.userId, context.mcpSessionId, sessionToken);
            return {
                content: [
                    {
                        type: "text",
                        text: `Session ${result.sessionToken} was released.`
                    }
                ],
                structuredContent: result as unknown as Record<string, unknown>
            };
        }
    );

    server.registerTool(
        "chatgpt_web.session_info",
        {
            description: "Return metadata about the currently bound browser chat session.",
            inputSchema: {
                sessionToken: z.string().trim().min(1).optional().describe("Optional explicit chat session token.")
            }
        },
        async ({ sessionToken }) => {
            const result = orchestrator.getSessionInfo(context.userId, context.mcpSessionId, sessionToken);
            return {
                content: [
                    {
                        type: "text",
                        text: `Session ${result.sessionToken} is ${result.status}.`
                    }
                ],
                structuredContent: result as unknown as Record<string, unknown>
            };
        }
    );

    return server;
}
