import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

type NativeHostRequest =
    | {
        type: "ensureBridge";
        bridgePort?: number;
        bridgeHost?: string;
        sessionId?: string;
        dataDir?: string;
    }
    | {
        type: "getStatus";
    }
    | {
        type: "stopBridge";
    };

type NativeHostEvent =
    | {
        type: "host-ready";
        pid: number;
        bridgeEntryPath: string;
    }
    | {
        type: "bridge-status";
        status: "idle" | "starting" | "ready" | "stopped" | "error";
        pid: number | null;
        baseUrl: string | null;
        sessionId: string | null;
        bridgeHost: string | null;
        bridgePort: number | null;
        detail: string | null;
        source: "child" | "existing" | "none";
    }
    | {
        type: "bridge-log";
        stream: "stderr" | "stdout";
        line: string;
    };

type BridgeStatus = Extract<NativeHostEvent, { type: "bridge-status" }>["status"];

interface BridgeConfig {
    bridgeHost: string;
    bridgePort: number;
    sessionId: string;
    dataDir?: string;
}

const DEFAULT_BRIDGE_HOST = "127.0.0.1";
const DEFAULT_BRIDGE_PORT = 4545;
const DEFAULT_SESSION_ID = "api";
const BRIDGE_READY_TIMEOUT_MS = 15000;
const BRIDGE_STOP_TIMEOUT_MS = 3000;
const HEALTH_POLL_INTERVAL_MS = 250;

const nativeHostDir = dirname(fileURLToPath(import.meta.url));
const bridgeEntryPath = join(nativeHostDir, "index.js");

let inputBuffer = Buffer.alloc(0);
let bridgeProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;
let currentBridgeConfig: BridgeConfig | null = null;
let currentBridgeBaseUrl: string | null = null;
let currentBridgeStatus: BridgeStatus = "idle";
let currentBridgeDetail: string | null = null;
let ensureBridgePromise: Promise<void> | null = null;
let messageQueue = Promise.resolve();

sendNativeMessage({
    type: "host-ready",
    pid: process.pid,
    bridgeEntryPath
});

process.stdin.on("data", (chunk) => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    pumpNativeMessages().catch((error) => {
        emitBridgeStatus("error", {
            detail: error instanceof Error ? error.message : String(error),
            source: "none"
        });
    });
});
process.stdin.on("end", () => {
    void shutdownHost();
});
process.stdin.resume();

process.once("SIGINT", () => {
    void shutdownHost();
});
process.once("SIGTERM", () => {
    void shutdownHost();
});

async function pumpNativeMessages() {
    while (inputBuffer.length >= 4) {
        const expectedLength = inputBuffer.readUInt32LE(0);
        if (inputBuffer.length < 4 + expectedLength) {
            return;
        }

        const bodyBuffer = inputBuffer.subarray(4, 4 + expectedLength);
        inputBuffer = inputBuffer.subarray(4 + expectedLength);
        const message = JSON.parse(bodyBuffer.toString("utf8")) as NativeHostRequest;
        messageQueue = messageQueue.then(() => handleNativeMessage(message));
        await messageQueue;
    }
}

async function handleNativeMessage(message: NativeHostRequest) {
    if (message.type === "ensureBridge") {
        await ensureBridge(message);
        return;
    }

    if (message.type === "getStatus") {
        emitBridgeStatus(currentBridgeStatus, {
            detail: currentBridgeDetail,
            source: bridgeProcess ? "child" : currentBridgeBaseUrl ? "existing" : "none"
        });
        return;
    }

    if (message.type === "stopBridge") {
        await stopBridge("Bridge stop requested by the extension.");
        emitBridgeStatus("stopped", {
            detail: "Bridge process was stopped.",
            source: "none"
        });
        return;
    }
}

async function ensureBridge(request: Extract<NativeHostRequest, { type: "ensureBridge" }>) {
    const requestedConfig = normalizeBridgeConfig(request);
    currentBridgeConfig = requestedConfig;

    if (ensureBridgePromise) {
        await ensureBridgePromise;
        return;
    }

    ensureBridgePromise = (async () => {
        if (currentBridgeBaseUrl && await isBridgeHealthy(currentBridgeBaseUrl, requestedConfig.sessionId)) {
            emitBridgeStatus("ready", {
                detail: "Reused an already running bridge.",
                source: bridgeProcess ? "child" : "existing"
            });
            return;
        }

        if (bridgeProcess && !bridgeProcess.killed) {
            await stopBridge("Restarting bridge with new configuration.");
        }

        currentBridgeStatus = "starting";
        currentBridgeDetail = "Starting local bridge process.";
        currentBridgeBaseUrl =
            requestedConfig.bridgePort > 0 ? `http://${requestedConfig.bridgeHost}:${requestedConfig.bridgePort}` : null;
        emitBridgeStatus("starting", {
            detail: currentBridgeDetail,
            source: "child"
        });

        if (currentBridgeBaseUrl && await isBridgeHealthy(currentBridgeBaseUrl, requestedConfig.sessionId)) {
            currentBridgeStatus = "ready";
            currentBridgeDetail = "Found an already running bridge on the requested port.";
            emitBridgeStatus("ready", {
                detail: currentBridgeDetail,
                source: "existing"
            });
            return;
        }

        const child = spawnBridgeProcess(requestedConfig);
        bridgeProcess = child;
        wireBridgeProcess(child);
        await waitForBridgeReadiness(requestedConfig);
        currentBridgeStatus = "ready";
        currentBridgeDetail = "Local bridge is ready.";
        emitBridgeStatus("ready", {
            detail: currentBridgeDetail,
            source: "child"
        });
    })();

    try {
        await ensureBridgePromise;
    } finally {
        ensureBridgePromise = null;
    }
}

function normalizeBridgeConfig(request: Extract<NativeHostRequest, { type: "ensureBridge" }>): BridgeConfig {
    const bridgeHost = typeof request.bridgeHost === "string" && request.bridgeHost.trim() ? request.bridgeHost.trim() : DEFAULT_BRIDGE_HOST;
    const rawBridgePort = request.bridgePort ?? DEFAULT_BRIDGE_PORT;
    if (!Number.isInteger(rawBridgePort) || rawBridgePort < 0 || rawBridgePort > 65535) {
        throw new Error(`Invalid bridgePort value: ${rawBridgePort}`);
    }

    const sessionId = typeof request.sessionId === "string" && request.sessionId.trim() ? request.sessionId.trim() : DEFAULT_SESSION_ID;
    const dataDir = typeof request.dataDir === "string" && request.dataDir.trim() ? request.dataDir.trim() : undefined;

    return {
        bridgeHost,
        bridgePort: rawBridgePort,
        sessionId,
        dataDir
    };
}

function spawnBridgeProcess(config: BridgeConfig) {
    const args = [
        bridgeEntryPath,
        "--transport=bridge",
        `--host=${config.bridgeHost}`,
        `--port=${config.bridgePort}`,
        `--session-id=${config.sessionId}`
    ];

    if (config.dataDir) {
        args.push(`--data-dir=${config.dataDir}`);
    }

    return spawn(process.execPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
    });
}

function wireBridgeProcess(child: ChildProcessByStdio<null, Readable, Readable>) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const stdoutReader = createInterface({ input: child.stdout });
    const stderrReader = createInterface({ input: child.stderr });
    stdoutReader.on("line", (line) => {
        emitBridgeLog("stdout", line);
    });
    stderrReader.on("line", (line) => {
        emitBridgeLog("stderr", line);
        const listeningBaseUrl = extractBridgeBaseUrl(line);
        if (listeningBaseUrl) {
            currentBridgeBaseUrl = listeningBaseUrl;
        }
    });

    child.once("exit", (code, signal) => {
        bridgeProcess = null;
        currentBridgeStatus = "stopped";
        currentBridgeDetail = `Bridge exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
        emitBridgeStatus("stopped", {
            detail: currentBridgeDetail,
            source: "none"
        });
    });

    child.once("error", (error) => {
        currentBridgeStatus = "error";
        currentBridgeDetail = error.message;
        emitBridgeStatus("error", {
            detail: error.message,
            source: "none"
        });
    });
}

function extractBridgeBaseUrl(line: string) {
    const match = line.match(/\[bridge\] Listening on (http:\/\/127\.0\.0\.1:\d+) for session /);
    return match?.[1] || null;
}

async function waitForBridgeReadiness(config: BridgeConfig) {
    const deadline = Date.now() + BRIDGE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (bridgeProcess && bridgeProcess.exitCode !== null) {
            throw new Error(`Bridge process exited before becoming ready (code=${bridgeProcess.exitCode}).`);
        }

        if (currentBridgeBaseUrl && await isBridgeHealthy(currentBridgeBaseUrl, config.sessionId)) {
            return;
        }

        await sleep(HEALTH_POLL_INTERVAL_MS);
    }

    throw new Error("Timed out while waiting for the local bridge to become ready.");
}

async function isBridgeHealthy(baseUrl: string, expectedSessionId: string) {
    try {
        const response = await fetch(`${baseUrl}/health`, {
            signal: AbortSignal.timeout(1000),
            cache: "no-store"
        });
        if (!response.ok) {
            return false;
        }

        const body = await response.json() as { ok?: boolean; sessionId?: string };
        return body.ok === true && body.sessionId === expectedSessionId;
    } catch {
        return false;
    }
}

async function stopBridge(detail: string) {
    if (!bridgeProcess) {
        currentBridgeStatus = "stopped";
        currentBridgeDetail = detail;
        return;
    }

    const child = bridgeProcess;
    bridgeProcess = null;
    currentBridgeStatus = "stopped";
    currentBridgeDetail = detail;

    child.kill();
    const stopped = await waitForProcessExit(child, BRIDGE_STOP_TIMEOUT_MS);
    if (!stopped) {
        child.kill("SIGKILL");
        await waitForProcessExit(child, BRIDGE_STOP_TIMEOUT_MS);
    }
}

async function shutdownHost() {
    await stopBridge("Native host is shutting down.");
    process.exit(0);
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number) {
    if (child.exitCode !== null) {
        return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve(false);
        }, timeoutMs);

        const handleExit = () => {
            cleanup();
            resolve(true);
        };

        const cleanup = () => {
            clearTimeout(timer);
            child.off("exit", handleExit);
        };

        child.once("exit", handleExit);
    });
}

function emitBridgeStatus(
    status: BridgeStatus,
    options: {
        detail: string | null;
        source: "child" | "existing" | "none";
    }
) {
    currentBridgeStatus = status;
    currentBridgeDetail = options.detail;
    sendNativeMessage({
        type: "bridge-status",
        status,
        pid: bridgeProcess?.pid ?? null,
        baseUrl: currentBridgeBaseUrl,
        sessionId: currentBridgeConfig?.sessionId ?? null,
        bridgeHost: currentBridgeConfig?.bridgeHost ?? null,
        bridgePort: currentBridgeConfig?.bridgePort ?? null,
        detail: options.detail,
        source: options.source
    });
}

function emitBridgeLog(stream: "stderr" | "stdout", line: string) {
    sendNativeMessage({
        type: "bridge-log",
        stream,
        line
    });
}

function sendNativeMessage(message: NativeHostEvent) {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    process.stdout.write(Buffer.concat([header, payload]));
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
