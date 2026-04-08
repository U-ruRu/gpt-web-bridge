import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createTempDir(prefix = "chatgpt-web-bridge-test-") {
    return await mkdtemp(join(tmpdir(), prefix));
}

export async function cleanupTempDir(directoryPath) {
    await rm(directoryPath, { recursive: true, force: true });
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(check, options = {}) {
    const timeoutMs = options.timeoutMs ?? 5000;
    const intervalMs = options.intervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const value = await check();
        if (value) {
            return value;
        }

        await sleep(intervalMs);
    }

    throw new Error(`Timed out after ${timeoutMs}ms while waiting for condition.`);
}

