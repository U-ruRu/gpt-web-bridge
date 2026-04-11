import { randomUUID } from "node:crypto";
import { DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT } from "./bridge/types.js";
import { ChatGptWebRuntime } from "./bridge/store.js";
import { listenBridgeServer, openExternalUrl, startBridgeServer } from "./bridge/server.js";
import { startStdioMcpServer } from "./mcp/server.js";
import { listenRemoteServer, startRemoteServer } from "./remote/server.js";

type TransportMode = "bridge" | "stdio" | "remote" | "server";

interface CliOptions {
    transport: TransportMode;
    host: string;
    port: number;
    sessionId: string;
    dataDir?: string;
    serverAccessToken: string;
    fullLog: boolean;
}

void main();

async function main() {
    const options = parseCliOptions(process.argv.slice(2));
    if (options.transport === "remote" || options.transport === "server") {
        const remoteServerHandle = startRemoteServer({
            host: options.host,
            port: options.port,
            serverAccessToken: options.serverAccessToken,
            dataRootDir: options.dataDir,
            fullLog: options.fullLog
        });
        const remoteAddress = await listenRemoteServer(remoteServerHandle.server, {
            host: options.host,
            port: options.port
        });

        try {
            console.error(`[server] Listening on ${remoteAddress.baseUrl}`);
            await waitForProcessExit();
        } finally {
            await remoteServerHandle.close();
        }
        return;
    }

    const runtime = new ChatGptWebRuntime({
        sessionId: options.sessionId,
        dataRootDir: options.dataDir
    });
    await runtime.initialize();

    const bridgeServer = startBridgeServer(runtime);
    const bridgeAddress = await listenBridgeServer(bridgeServer, {
        host: options.host,
        port: options.transport === "stdio" ? 0 : options.port
    });

    let mcpServer: Awaited<ReturnType<typeof startStdioMcpServer>> | null = null;

    try {
        console.error(`[bridge] Listening on ${bridgeAddress.baseUrl} for session ${runtime.sessionId}`);

        if (options.transport === "stdio") {
            await tryRestoreConversation(runtime, bridgeAddress.port);
            mcpServer = await startStdioMcpServer(runtime, {
                bridgePort: bridgeAddress.port
            });
            console.error(`[mcp] MCP stdio server is ready for session ${runtime.sessionId}`);
            await waitForProcessExit();
            return;
        }

        console.error("[bridge] HTTP bridge mode is running.");
        await waitForProcessExit();
    } finally {
        await Promise.allSettled([
            mcpServer?.close(),
            closeHttpServer(bridgeServer)
        ]);
    }
}

async function tryRestoreConversation(runtime: ChatGptWebRuntime, bridgePort: number) {
    if (!runtime.hasRestorableConversation()) {
        return;
    }

    try {
        const restored = await runtime.restoreConversationLaunch(bridgePort, openExternalUrl);
        if (restored) {
            console.error(
                `[runtime] Restored conversation ${runtime.getRestorableConversationUrl()} for session ${runtime.sessionId}`
            );
        }
    } catch (error) {
        console.error("[runtime] Failed to restore the previous conversation. Continuing with manual recovery.", error);
    }
}

function parseCliOptions(args: string[]): CliOptions {
    const options = new Map<string, string>();
    for (const arg of args) {
        if (!arg.startsWith("--")) {
            continue;
        }

        const separatorIndex = arg.indexOf("=");
        if (separatorIndex === -1) {
            options.set(arg.slice(2), "true");
            continue;
        }

        options.set(arg.slice(2, separatorIndex), arg.slice(separatorIndex + 1));
    }

    const transport = parseTransportMode(options.get("transport"));
    const host = options.get("host") || process.env.CHATGPT_WEB_BRIDGE_HOST || DEFAULT_BRIDGE_HOST;
    const port = parsePort(options.get("port") || process.env.CHATGPT_WEB_BRIDGE_PORT, DEFAULT_BRIDGE_PORT);
    const sessionId =
        options.get("session-id") ||
        process.env.CHATGPT_WEB_BRIDGE_SESSION_ID ||
        (transport === "stdio" ? randomUUID() : "api");
    const dataDir = options.get("data-dir") || process.env.CHATGPT_WEB_BRIDGE_DATA_DIR || undefined;
    const serverAccessToken =
        options.get("server-access-token") ||
        process.env.CHATGPT_WEB_BRIDGE_SERVER_ACCESS_TOKEN ||
        "dev-server-access-token";
    const fullLog = parseBooleanFlag(
        options.get("full-log") ||
        options.get("fulllog") ||
        process.env.CHATGPT_WEB_BRIDGE_FULL_LOG
    );

    return {
        transport,
        host,
        port,
        sessionId,
        dataDir,
        serverAccessToken,
        fullLog
    };
}

function parseTransportMode(rawValue: string | undefined): TransportMode {
    if (!rawValue || rawValue === "bridge") {
        return "bridge";
    }

    if (rawValue === "stdio") {
        return "stdio";
    }

    if (rawValue === "remote" || rawValue === "server") {
        return "remote";
    }

    throw new Error(`Unsupported transport mode: ${rawValue}`);
}

function parsePort(rawValue: string | undefined, defaultValue: number) {
    if (!rawValue) {
        return defaultValue;
    }

    const port = Number(rawValue);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port value: ${rawValue}`);
    }

    return port;
}

function parseBooleanFlag(rawValue: string | undefined) {
    if (!rawValue) {
        return false;
    }

    return /^(1|true|yes|on)$/i.test(rawValue.trim());
}

async function waitForProcessExit() {
    await new Promise<void>((resolve) => {
        let resolved = false;
        const finish = () => {
            if (resolved) {
                return;
            }

            resolved = true;
            resolve();
        };

        process.once("SIGINT", finish);
        process.once("SIGTERM", finish);
    });
}

async function closeHttpServer(server: Parameters<typeof listenBridgeServer>[0]) {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    });
}
