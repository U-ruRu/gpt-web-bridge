import { spawn } from "node:child_process";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { ChatGptWebRuntime } from "./store.js";
import { BridgeServerOptions, DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT, HttpError, JobStatusPatch } from "./types.js";

type JsonObject = Record<string, unknown>;
interface OpenUrlProcessConfig {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
}

export function startBridgeServer(runtime: ChatGptWebRuntime) {
    return createServer(async (request, response) => {
        try {
            await routeRequest(runtime, request, response);
        } catch (error) {
            handleError(response, error);
        }
    });
}

export async function listenBridgeServer(server: Server, options: Partial<BridgeServerOptions> = {}) {
    const host = options.host ?? DEFAULT_BRIDGE_HOST;
    const port = options.port ?? DEFAULT_BRIDGE_PORT;

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Unable to determine bridge server address.");
    }

    return {
        host: address.address,
        port: address.port,
        baseUrl: `http://${address.address}:${address.port}`
    };
}

export async function openExternalUrl(targetUrl: string) {
    const processConfig = getOpenUrlProcessConfig(targetUrl);
    await new Promise<void>((resolve, reject) => {
        const child = spawn(processConfig.command, processConfig.args, {
            stdio: "ignore",
            env: processConfig.env
        });

        let resolved = false;
        let settled = false;
        const finishResolve = () => {
            if (settled) {
                return;
            }

            settled = true;
            resolved = true;
            resolve();
        };
        const finishReject = (error: Error) => {
            if (settled) {
                return;
            }

            settled = true;
            reject(error);
        };

        child.once("error", finishReject);
        child.once("spawn", () => {
            child.unref();
            setTimeout(() => {
                if (!settled) {
                    finishResolve();
                }
            }, 300);
        });
        child.once("exit", (code, signal) => {
            if (resolved) {
                return;
            }

            if (code === 0) {
                finishResolve();
                return;
            }

            finishReject(
                new Error(
                    `External URL launcher exited before opening the browser (command=${processConfig.command}, code=${code ?? "null"}, signal=${signal ?? "null"}).`
                )
            );
        });
    });
}

async function routeRequest(runtime: ChatGptWebRuntime, request: IncomingMessage, response: ServerResponse) {
    addCorsHeaders(response);

    if (!request.url || !request.method) {
        throw new HttpError(400, "Malformed HTTP request.");
    }

    if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
    }

    const url = new URL(request.url, "http://127.0.0.1");
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/health") {
        return sendJson(response, 200, {
            ok: true,
            sessionId: runtime.sessionId
        });
    }

    if (request.method === "GET" && pathname === "/newchat") {
        const waitTimeoutMs = readQueryInteger(url.searchParams, "waitTimeoutMs", 30000, 1000, 120000);
        const waitForReady = readQueryBoolean(url.searchParams, "waitForReady", true);
        const bridgePort = getRequestBridgePort(request);
        await runtime.recordClientLog("bridge", "info", "HTTP newchat request received.", {
            bridgePort,
            waitTimeoutMs,
            waitForReady
        });

        if (!waitForReady) {
            const prepared = await runtime.prepareNewChatLaunch(bridgePort);
            await openExternalUrl(prepared.launchUrl);
            await runtime.recordClientLog("bridge", "info", "HTTP newchat request started without waiting for readiness.", {
                bridgePort,
                launchToken: prepared.launch.token,
                launchUrl: prepared.launchUrl
            });
            return sendJson(response, 202, {
                ok: true,
                sessionId: runtime.sessionId,
                isTemporary: false,
                status: prepared.launch.status,
                detail: "Browser launch initiated. Poll /debug/state to track claim and readiness.",
                launchToken: prepared.launch.token,
                launchUrl: prepared.launchUrl,
                waitForReady: false
            });
        }

        return sendJson(response, 200, await runtime.newChat(bridgePort, openExternalUrl, waitTimeoutMs));
    }

    if (request.method === "GET" && pathname === "/setTemporary") {
        const waitTimeoutMs = readQueryInteger(url.searchParams, "waitTimeoutMs", 30000, 1000, 120000);
        await runtime.recordClientLog("bridge", "info", "HTTP setTemporary request received.", {
            waitTimeoutMs
        });
        return sendJson(response, 200, await runtime.setTemporary(waitTimeoutMs));
    }

    if (request.method === "GET" && pathname === "/automation/pending") {
        const launch = runtime.getPendingAutomationLaunch();
        if (!launch) {
            response.writeHead(204);
            response.end();
            return;
        }

        return sendJson(response, 200, launch);
    }

    if (request.method === "GET" && pathname === "/automation/command") {
        const command = runtime.getPendingAutomationCommand();
        if (!command) {
            response.writeHead(204);
            response.end();
            return;
        }

        return sendJson(response, 200, command);
    }

    if (request.method === "POST" && pathname === "/automation/claim") {
        const body = await readJsonBody(request);
        const token = readString(body, "token");
        const status = readAutomationLaunchStatus(body, "status");
        const detail = body.detail === undefined ? undefined : readString(body, "detail");
        return sendJson(response, 200, await runtime.updateAutomationLaunch(token, status, detail));
    }

    if (request.method === "POST" && pathname === "/automation/command/status") {
        const body = await readJsonBody(request);
        const token = readString(body, "token");
        const status = readAutomationCommandStatus(body, "status");
        const detail = body.detail === undefined ? undefined : readString(body, "detail");
        return sendJson(response, 200, await runtime.updateAutomationCommand(token, status, detail));
    }

    if (request.method === "POST" && pathname === "/logs/client") {
        const body = await readJsonBody(request);
        const source = readString(body, "source");
        const level = readLogLevel(body, "level");
        const message = readString(body, "message");
        const context = readOptionalObject(body, "context");
        await runtime.recordClientLog(source, level, message, context);
        return sendJson(response, 200, { ok: true });
    }

    if (request.method === "GET" && pathname === "/session/active") {
        return sendJson(response, 200, runtime.getSessionView());
    }

    if (request.method === "GET" && pathname === "/debug/state") {
        return sendJson(response, 200, runtime.getDiagnosticsView());
    }

    if (request.method === "POST" && pathname === "/session/open") {
        const body = await readJsonBody(request);
        const sessionId = readString(body, "sessionId");
        assertRuntimeSession(runtime, sessionId);
        return sendJson(response, 200, runtime.getSessionView());
    }

    if (request.method === "POST" && pathname === "/session/reset") {
        const body = await readJsonBody(request);
        const sessionId = readString(body, "sessionId");
        assertRuntimeSession(runtime, sessionId);
        return sendJson(response, 200, await runtime.resetSession());
    }

    if (request.method === "GET" && pathname === "/session/next") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) {
            throw new HttpError(400, "sessionId query parameter is required.");
        }

        const job = runtime.claimNextJob(sessionId);
        if (!job) {
            response.writeHead(204);
            response.end();
            return;
        }

        return sendJson(response, 200, job);
    }

    if (request.method === "POST" && pathname === "/jobs") {
        const body = await readJsonBody(request);
        const sessionId = readString(body, "sessionId");
        assertRuntimeSession(runtime, sessionId);
        const text = readString(body, "text");
        const waitForResponse = readBoolean(body, "waitForResponse", true);
        const waitTimeoutMs = readInteger(body, "waitTimeoutMs", 240000, 1000, 900000);
        const job = runtime.queueJob(text);
        if (!waitForResponse) {
            return sendJson(response, 202, {
                jobId: job.id,
                status: job.status,
                job
            });
        }

        const resolvedJob = await runtime.waitForJobResolution(job.id, waitTimeoutMs);
        const statusCode = resolvedJob.status === "failed" ? 502 : 200;
        return sendJson(response, statusCode, {
            jobId: resolvedJob.id,
            status: resolvedJob.status,
            detail: resolvedJob.detail,
            conversationUrl: resolvedJob.conversationUrl,
            responseText: resolvedJob.responseText,
            job: resolvedJob
        });
    }

    if (request.method === "POST" && pathname === "/ask") {
        const body = await readJsonBody(request);
        const requestText = readString(body, "request");
        const waitTimeoutMs = readInteger(body, "waitTimeoutMs", 240000, 1000, 900000);
        await runtime.recordClientLog("bridge", "info", "HTTP ask request received.", {
            waitTimeoutMs,
            textLength: requestText.length
        });
        const result = await runtime.ask(requestText, waitTimeoutMs);
        const statusCode = result.status === "failed" ? 502 : 200;
        return sendJson(response, statusCode, result);
    }

    const jobStatusMatch = pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (request.method === "POST" && jobStatusMatch?.[1]) {
        const body = await readJsonBody(request);
        const patch = readJobStatusPatch(body);
        return sendJson(response, 200, await runtime.updateJobStatus(jobStatusMatch[1], patch));
    }

    const jobMatch = pathname.match(/^\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch?.[1]) {
        return sendJson(response, 200, runtime.getJob(jobMatch[1]));
    }

    throw new HttpError(404, "Route not found.", {
        method: request.method,
        pathname
    });
}

function addCorsHeaders(response: ServerResponse) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Cache-Control", "no-store");
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
    response.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8"
    });
    response.end(JSON.stringify(payload, null, 2));
}

function handleError(response: ServerResponse, error: unknown) {
    addCorsHeaders(response);

    if (error instanceof HttpError) {
        sendJson(response, error.statusCode, {
            error: error.message,
            details: error.details ?? null
        });
        return;
    }

    console.error("[bridge] Unhandled error:", error);
    sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Internal server error.",
        details: error instanceof Error ? { name: error.name, stack: error.stack ?? null } : null
    });
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    if (chunks.length === 0) {
        return {};
    }

    const raw = decodeRequestBody(Buffer.concat(chunks), request.headers["content-type"]);
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new HttpError(400, "JSON body must be an object.");
        }

        return parsed as JsonObject;
    } catch (error) {
        if (error instanceof HttpError) {
            throw error;
        }

        throw new HttpError(400, "Invalid JSON body.");
    }
}

function decodeRequestBody(buffer: Buffer, contentTypeHeader: string | string[] | undefined): string {
    const charset = extractCharset(contentTypeHeader) || detectBodyCharset(buffer) || "utf-8";
    try {
        return new TextDecoder(charset, { fatal: false }).decode(buffer);
    } catch {
        return buffer.toString("utf8");
    }
}

function extractCharset(contentTypeHeader: string | string[] | undefined): string | null {
    const value = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
    if (!value) {
        return null;
    }

    const match = value.match(/charset\s*=\s*("?)([^";,\s]+)\1/i);
    return match?.[2]?.trim().toLowerCase() || null;
}

function detectBodyCharset(buffer: Buffer): string | null {
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
        return "utf-8";
    }

    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return "utf-16le";
    }

    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        return "utf-16be";
    }

    let evenNulls = 0;
    let oddNulls = 0;
    for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] === 0x00) {
            if (index % 2 === 0) {
                evenNulls += 1;
            } else {
                oddNulls += 1;
            }
        }
    }

    if (oddNulls > 0 && evenNulls === 0) {
        return "utf-16le";
    }

    if (evenNulls > 0 && oddNulls === 0) {
        return "utf-16be";
    }

    return null;
}

function readString(body: JsonObject, key: string): string {
    const value = body[key];
    if (typeof value !== "string") {
        throw new HttpError(400, `${key} must be a string.`);
    }

    return value;
}

function readBoolean(body: JsonObject, key: string, defaultValue: boolean): boolean {
    const value = body[key];
    if (value === undefined) {
        return defaultValue;
    }

    if (typeof value !== "boolean") {
        throw new HttpError(400, `${key} must be a boolean.`);
    }

    return value;
}

function readInteger(
    body: JsonObject,
    key: string,
    defaultValue: number,
    minValue: number,
    maxValue: number
): number {
    const value = body[key];
    if (value === undefined) {
        return defaultValue;
    }

    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new HttpError(400, `${key} must be an integer.`);
    }

    if (value < minValue || value > maxValue) {
        throw new HttpError(400, `${key} must be between ${minValue} and ${maxValue}.`);
    }

    return value;
}

function readQueryInteger(
    searchParams: URLSearchParams,
    key: string,
    defaultValue: number,
    minValue: number,
    maxValue: number
) {
    if (!searchParams.has(key)) {
        return defaultValue;
    }

    const rawValue = searchParams.get(key);
    if (!rawValue) {
        return defaultValue;
    }

    const value = Number(rawValue);
    if (!Number.isInteger(value)) {
        throw new HttpError(400, `${key} must be an integer.`);
    }

    if (value < minValue || value > maxValue) {
        throw new HttpError(400, `${key} must be between ${minValue} and ${maxValue}.`);
    }

    return value;
}

function readQueryBoolean(searchParams: URLSearchParams, key: string, defaultValue: boolean) {
    if (!searchParams.has(key)) {
        return defaultValue;
    }

    const rawValue = searchParams.get(key);
    if (rawValue === null) {
        return defaultValue;
    }

    if (/^(1|true|yes|on)$/i.test(rawValue)) {
        return true;
    }

    if (/^(0|false|no|off)$/i.test(rawValue)) {
        return false;
    }

    throw new HttpError(400, `${key} must be a boolean.`);
}

function readJobStatusPatch(body: JsonObject): JobStatusPatch {
    const status = readString(body, "status");
    if (!isJobStatus(status)) {
        throw new HttpError(400, "status must be one of queued, running, sent, failed.");
    }

    const patch: JobStatusPatch = { status };
    if (body.detail !== undefined) {
        patch.detail = readString(body, "detail");
    }

    if (body.conversationUrl !== undefined) {
        patch.conversationUrl = readString(body, "conversationUrl");
    }

    if (body.responseText !== undefined) {
        patch.responseText = readString(body, "responseText");
    }

    return patch;
}

function isJobStatus(value: string): value is JobStatusPatch["status"] {
    return value === "queued" || value === "running" || value === "sent" || value === "failed";
}

function readAutomationLaunchStatus(body: JsonObject, key: string) {
    const value = readString(body, key);
    if (value === "pending" || value === "claimed" || value === "ready" || value === "failed") {
        return value;
    }

    throw new HttpError(400, `${key} must be one of pending, claimed, ready, failed.`);
}

function readAutomationCommandStatus(body: JsonObject, key: string) {
    const value = readString(body, key);
    if (value === "pending" || value === "running" || value === "completed" || value === "failed") {
        return value;
    }

    throw new HttpError(400, `${key} must be one of pending, running, completed, failed.`);
}

function readLogLevel(body: JsonObject, key: string) {
    const value = readString(body, key);
    if (value === "debug" || value === "info" || value === "warn" || value === "error") {
        return value;
    }

    throw new HttpError(400, `${key} must be one of debug, info, warn, error.`);
}

function readOptionalObject(body: JsonObject, key: string): Record<string, unknown> | undefined {
    const value = body[key];
    if (value === undefined) {
        return undefined;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpError(400, `${key} must be an object.`);
    }

    return value as Record<string, unknown>;
}

function assertRuntimeSession(runtime: ChatGptWebRuntime, sessionId: string) {
    if (runtime.sessionId !== sessionId.trim()) {
        throw new HttpError(409, "The requested session does not belong to this bridge runtime.", {
            sessionId,
            expectedSessionId: runtime.sessionId
        });
    }
}

function getRequestBridgePort(request: IncomingMessage) {
    const address = request.socket.localAddress ? request.socket.address() : null;
    if (!address || typeof address === "string") {
        throw new HttpError(500, "Unable to determine bridge port.");
    }

    return (address as AddressInfo).port;
}

export function getOpenUrlProcessConfig(
    targetUrl: string,
    platform = process.platform,
    env: NodeJS.ProcessEnv = process.env
): OpenUrlProcessConfig {
    if (platform === "win32") {
        const systemRoot = env.SYSTEMROOT || env.WINDIR || "C:\\Windows";
        const powershellPath = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
        return {
            command: powershellPath,
            args: [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "Start-Process -FilePath $env:CHATGPT_WEB_BRIDGE_TARGET_URL"
            ],
            env: {
                ...env,
                CHATGPT_WEB_BRIDGE_TARGET_URL: targetUrl
            }
        };
    }

    if (platform === "darwin") {
        return {
            command: "open",
            args: [targetUrl],
            env
        };
    }

    return {
        command: "xdg-open",
        args: [targetUrl],
        env
    };
}
