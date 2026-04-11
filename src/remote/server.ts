import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebSocketServer, type WebSocket } from "ws";
import { HttpError } from "../bridge/types.js";
import { createConnectedAgentRecord, RemoteOrchestrator } from "./orchestrator.js";
import { createRemoteMcpServer } from "./mcp.js";
import type { AgentToServerMessage, ConnectedAgentRecord } from "./types.js";

interface RemoteServerOptions {
    host: string;
    port: number;
    serverAccessToken: string;
    dataRootDir?: string;
    fullLog?: boolean;
}

interface RemoteServerHandle {
    server: Server;
    close(): Promise<void>;
}

interface McpSessionHandle {
    sessionId: string;
    userId: string;
    server: ReturnType<typeof createRemoteMcpServer>;
    transport: StreamableHTTPServerTransport;
    isDisposed: boolean;
}

interface RemoteServerLogger {
    info(scope: string, message: string, details?: Record<string, unknown>): void;
    debug(scope: string, message: string, details?: Record<string, unknown>): void;
}

const USER_TOKEN_HEADER = "x-chatgpt-web-bridge-user-token";

export function startRemoteServer(options: RemoteServerOptions): RemoteServerHandle {
    const logger = createRemoteServerLogger(Boolean(options.fullLog));
    const orchestrator = new RemoteOrchestrator({
        serverAccessToken: options.serverAccessToken,
        dataRootDir: options.dataRootDir,
        logger: {
            debug(message, details) {
                logger.debug("orchestrator", message, details);
            }
        }
    });
    const mcpSessions = new Map<string, McpSessionHandle>();
    const websocketServer = new WebSocketServer({ noServer: true });

    const server = createServer(async (request, response) => {
        try {
            await routeRemoteRequest(orchestrator, mcpSessions, request, response, logger);
        } catch (error) {
            handleHttpError(response, request, error, logger);
        }
    });

    server.on("upgrade", (request, socket, head) => {
        let url: URL;
        try {
            url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
        } catch {
            socket.destroy();
            return;
        }

        if (url.pathname !== "/agent/ws") {
            socket.destroy();
            return;
        }

        logger.info("agent", "WebSocket upgrade request received.", {
            remoteAddress: request.socket.remoteAddress || null
        });
        websocketServer.handleUpgrade(request, socket, head, (websocket) => {
            wireAgentSocket(orchestrator, websocket, request.socket.remoteAddress || null, logger);
        });
    });

    return {
        server,
        async close() {
            await Promise.all([
                new Promise<void>((resolve, reject) => {
                    websocketServer.close((error) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve();
                    });
                }),
                new Promise<void>((resolve, reject) => {
                    server.close((error) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve();
                    });
                }),
                ...[...mcpSessions.values()].map((session) => disposeMcpSession(orchestrator, mcpSessions, session, true, logger))
            ]);
        }
    };
}

export async function listenRemoteServer(server: Server, options: Pick<RemoteServerOptions, "host" | "port">) {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => {
            server.off("error", reject);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Unable to determine remote server address.");
    }

    return {
        host: address.address,
        port: address.port,
        baseUrl: `http://${address.address}:${address.port}`
    };
}

async function routeRemoteRequest(
    orchestrator: RemoteOrchestrator,
    mcpSessions: Map<string, McpSessionHandle>,
    request: IncomingMessage,
    response: ServerResponse,
    logger: RemoteServerLogger
) {
    addCorsHeaders(response);
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    logger.debug("http", "Incoming request.", {
        method: request.method || "UNKNOWN",
        path: url.pathname,
        hasSessionId: Boolean(readSessionIdHeader(request))
    });

    if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, orchestrator.getHealthView());
        return;
    }

    if (url.pathname !== "/mcp") {
        throw new HttpError(404, "Not found.");
    }

    const serverAccessToken = readBearerToken(request);
    orchestrator.verifyServerAccessToken(serverAccessToken);

    const userToken = readRequiredHeader(request, USER_TOKEN_HEADER);
    const userId = orchestrator.resolveUserId(userToken);
    const sessionId = readSessionIdHeader(request);

    let handle = sessionId ? mcpSessions.get(sessionId) : null;
    if (handle && handle.userId !== userId) {
        throw new HttpError(403, "The MCP session belongs to another user.");
    }

    if (!handle) {
        if (sessionId) {
            throw new HttpError(404, "Unknown MCP session id.");
        }

        handle = await createMcpSessionHandle(orchestrator, userId);
        mcpSessions.set(handle.sessionId, handle);
        logger.info("mcp", "Created MCP transport session.", {
            sessionId: handle.sessionId,
            userId: maskIdentifier(userId)
        });
        const createdHandle = handle;
        createdHandle.transport.onclose = () => {
            void disposeMcpSession(orchestrator, mcpSessions, createdHandle, false, logger);
        };
    }

    orchestrator.ensureMcpBinding(handle.sessionId, userId);
    await handle.transport.handleRequest(request, response);
}

async function createMcpSessionHandle(orchestrator: RemoteOrchestrator, userId: string): Promise<McpSessionHandle> {
    const sessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        enableJsonResponse: true
    });
    const server = createRemoteMcpServer(orchestrator, {
        userId,
        mcpSessionId: sessionId
    });
    await server.connect(transport);
    return {
        sessionId,
        userId,
        server,
        transport,
        isDisposed: false
    };
}

async function disposeMcpSession(
    orchestrator: RemoteOrchestrator,
    mcpSessions: Map<string, McpSessionHandle>,
    session: McpSessionHandle,
    closeServer: boolean,
    logger?: RemoteServerLogger
) {
    if (session.isDisposed) {
        return;
    }

    session.isDisposed = true;
    mcpSessions.delete(session.sessionId);
    orchestrator.closeMcpBinding(session.sessionId);
    logger?.info("mcp", "Disposed MCP transport session.", {
        sessionId: session.sessionId,
        userId: maskIdentifier(session.userId),
        closeServer
    });

    if (!closeServer) {
        return;
    }

    await session.server.close();
}

function wireAgentSocket(
    orchestrator: RemoteOrchestrator,
    websocket: WebSocket,
    remoteAddress: string | null,
    logger: RemoteServerLogger
) {
    let userId: string | null = null;
    let agentId: string | null = null;
    let ready = false;

    const forceClose = (code: number, reason: string) => {
        try {
            websocket.close(code, reason);
        } catch {
            websocket.terminate();
        }
    };

    const sendMessage = (payload: unknown) => {
        websocket.send(JSON.stringify(payload));
    };

    websocket.on("message", (payload) => {
        try {
            const message = JSON.parse(payload.toString("utf8")) as AgentToServerMessage;
            if (!ready) {
                if (message.type !== "agent.hello") {
                    logger.info("agent", "Rejected agent socket because the first message was not agent.hello.", {
                        remoteAddress
                    });
                    forceClose(4000, "The first WebSocket message must be agent.hello.");
                    return;
                }

                const assignedAgentId = message.agentId?.trim() || randomUUID();
                const agent = createConnectedAgentRecord(
                    assignedAgentId,
                    message.browserName,
                    message.browserVersion,
                    (serverMessage: Parameters<ConnectedAgentRecord["send"]>[0]) => {
                        sendMessage(serverMessage);
                    },
                    (code: number | undefined, reason: string | undefined) =>
                        forceClose(code ?? 4001, reason ?? "Agent connection closed.")
                );
                const registration = orchestrator.registerAgent(message, agent);
                userId = registration.userId;
                agentId = registration.agentId;
                ready = true;
                logger.info("agent", "Browser agent is ready.", {
                    agentId: registration.agentId,
                    userId: maskIdentifier(registration.userId),
                    browserName: message.browserName || null,
                    browserVersion: message.browserVersion || null,
                    remoteAddress
                });
                sendMessage({
                    type: "agent.ready",
                    agentId: registration.agentId,
                    userId: registration.userId
                });
                return;
            }

            if (!userId) {
                forceClose(1011, "Agent user binding is missing.");
                return;
            }

            if (message.type === "agent.log") {
                const logDetails = {
                    userId: maskIdentifier(userId),
                    agentId,
                    source: typeof message.context?.source === "string" ? message.context.source : null,
                    context: message.context || {}
                };
                if (message.level === "warn" || message.level === "error") {
                    logger.info("agent.log", message.message, {
                        level: message.level,
                        ...logDetails
                    });
                } else {
                    logger.debug("agent.log", message.message, {
                        level: message.level,
                        ...logDetails
                    });
                }
            } else {
                logger.debug("agent", "Received agent message.", {
                    type: message.type,
                    userId: userId ? maskIdentifier(userId) : null,
                    agentId
                });
            }

            orchestrator.handleAgentMessage(userId, message);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.info("agent", "Failed to process an agent WebSocket message.", {
                error: message,
                remoteAddress,
                userId: userId ? maskIdentifier(userId) : null,
                agentId
            });
            sendMessage({
                type: "agent.error",
                message
            });
        }
    });

    websocket.on("close", () => {
        if (ready && userId && agentId) {
            orchestrator.disconnectAgent(userId, agentId);
        }
        logger.info("agent", "Browser agent socket closed.", {
            agentId,
            userId: userId ? maskIdentifier(userId) : null,
            remoteAddress
        });
    });

    websocket.on("error", (error) => {
        if (ready && userId && agentId) {
            orchestrator.disconnectAgent(userId, agentId);
        }
        logger.info("agent", "Browser agent socket failed.", {
            agentId,
            userId: userId ? maskIdentifier(userId) : null,
            remoteAddress,
            error: error.message
        });
    });
}

function readBearerToken(request: IncomingMessage) {
    const headerValue = request.headers.authorization;
    if (typeof headerValue !== "string") {
        return null;
    }

    const match = headerValue.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || null;
}

function readRequiredHeader(request: IncomingMessage, headerName: string) {
    const rawValue = request.headers[headerName];
    const normalizedValue = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (typeof normalizedValue !== "string" || !normalizedValue.trim()) {
        throw new HttpError(400, `Missing required header: ${headerName}.`);
    }

    return normalizedValue.trim();
}

function readSessionIdHeader(request: IncomingMessage) {
    const rawValue = request.headers["mcp-session-id"];
    const normalizedValue = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (typeof normalizedValue !== "string") {
        return null;
    }

    const sessionId = normalizedValue.trim();
    return sessionId || null;
}

function handleHttpError(response: ServerResponse, request: IncomingMessage, error: unknown, logger: RemoteServerLogger) {
    const requestPath = request.url || "/";
    if (error instanceof HttpError) {
        logger.info("http", "Request failed with an HTTP error.", {
            method: request.method || "UNKNOWN",
            path: requestPath,
            statusCode: error.statusCode,
            message: error.message
        });
        sendJson(response, error.statusCode, {
            ok: false,
            error: error.message,
            details: error.details ?? null
        });
        return;
    }

    logger.info("http", "Request failed with an unexpected error.", {
        method: request.method || "UNKNOWN",
        path: requestPath,
        error: error instanceof Error ? error.message : String(error)
    });
    sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "Internal server error."
    });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
    response.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8"
    });
    response.end(JSON.stringify(body));
}

function addCorsHeaders(response: ServerResponse) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", `authorization, content-type, mcp-session-id, ${USER_TOKEN_HEADER}`);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}

function logServerEvent(scope: string, message: string, details?: Record<string, unknown>) {
    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    console.error(`[${scope}] ${message}${suffix}`);
}

function createRemoteServerLogger(fullLog: boolean): RemoteServerLogger {
    return {
        info(scope, message, details) {
            logServerEvent(scope, message, details);
        },
        debug(scope, message, details) {
            if (!fullLog) {
                return;
            }

            logServerEvent(scope, message, details);
        }
    };
}

function maskIdentifier(value: string) {
    if (value.length <= 12) {
        return value;
    }

    return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
