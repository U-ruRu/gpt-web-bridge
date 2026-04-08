import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { openExternalUrl } from "../bridge/server.js";
import { ChatGptWebRuntime } from "../bridge/store.js";

interface McpServerContext {
    bridgePort: number;
}

export async function startStdioMcpServer(runtime: ChatGptWebRuntime, context: McpServerContext) {
    const server = new McpServer({
        name: "chatgpt-web-bridge",
        version: "0.2.0"
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
        "chatgpt_web.ask",
        {
            description: "Send a request to the currently attached ChatGPT web chat and return the assistant response as plain text.",
            inputSchema: {
                request: z.string().min(1).describe("The prompt text to send to ChatGPT through the web interface.")
            }
        },
        async ({ request }) => {
            const result = await runtime.ask(request);
            return {
                content: [
                    {
                        type: "text",
                        text: result.responseText
                    }
                ],
                structuredContent: toStructuredContent(result)
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
