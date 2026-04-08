import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cleanupTempDir, createTempDir, waitFor } from "./helpers.js";

const projectDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const nativeHostEntryPath = join(projectDir, "dist", "native-host.js");

function createNativeMessagingClient(child) {
    let inputBuffer = Buffer.alloc(0);
    const messages = [];

    child.stdout.on("data", (chunk) => {
        inputBuffer = Buffer.concat([inputBuffer, chunk]);
        while (inputBuffer.length >= 4) {
            const payloadLength = inputBuffer.readUInt32LE(0);
            if (inputBuffer.length < 4 + payloadLength) {
                break;
            }

            const payloadBuffer = inputBuffer.subarray(4, 4 + payloadLength);
            inputBuffer = inputBuffer.subarray(4 + payloadLength);
            messages.push(JSON.parse(payloadBuffer.toString("utf8")));
        }
    });

    return {
        send(message) {
            const payloadBuffer = Buffer.from(JSON.stringify(message), "utf8");
            const headerBuffer = Buffer.alloc(4);
            headerBuffer.writeUInt32LE(payloadBuffer.length, 0);
            child.stdin.write(Buffer.concat([headerBuffer, payloadBuffer]));
        },
        messages
    };
}

test("native host starts the local bridge and reports a ready status", { timeout: 25000 }, async (t) => {
    const dataRootDir = await createTempDir();
    t.after(async () => {
        await cleanupTempDir(dataRootDir);
    });

    const child = spawn(process.execPath, [nativeHostEntryPath], {
        cwd: projectDir,
        stdio: ["pipe", "pipe", "pipe"]
    });

    t.after(async () => {
        child.kill();
    });

    const client = createNativeMessagingClient(child);
    client.send({
        type: "ensureBridge",
        bridgeHost: "127.0.0.1",
        bridgePort: 0,
        sessionId: "native-host-session",
        dataDir: dataRootDir
    });

    const readyMessage = await waitFor(() => {
        return client.messages.find((message) => message.type === "bridge-status" && message.status === "ready") || null;
    }, {
        timeoutMs: 15000,
        intervalMs: 100
    });

    assert.equal(readyMessage.sessionId, "native-host-session");
    assert.match(readyMessage.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    const healthResponse = await fetch(`${readyMessage.baseUrl}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
        ok: true,
        sessionId: "native-host-session"
    });
});
