import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

async function loadBackgroundHelpers() {
    const source = await readFile(join(projectDir, "extension", "background.js"), "utf8");
    const normalizeNullableStringMatch = source.match(/function normalizeNullableString\(value\) \{[\s\S]*?\n\}/);
    const normalizeBridgeBaseUrlMatch = source.match(/function normalizeBridgeBaseUrl\(value\) \{[\s\S]*?\n\}/);
    const resolveLaunchPendingMatch = source.match(/function resolveLaunchPending\(existingMetadata, launchContext\) \{[\s\S]*?\n\}/);

    assert.ok(normalizeNullableStringMatch, "normalizeNullableString() should be declared in background.js");
    assert.ok(normalizeBridgeBaseUrlMatch, "normalizeBridgeBaseUrl() should be declared in background.js");
    assert.ok(resolveLaunchPendingMatch, "resolveLaunchPending() should be declared in background.js");

    const module = { exports: {} };
    const factory = new Function(
        "module",
        "exports",
        `"use strict"; ${normalizeNullableStringMatch[0]} ${normalizeBridgeBaseUrlMatch[0]} ${resolveLaunchPendingMatch[0]} module.exports = { resolveLaunchPending };`
    );
    factory(module, module.exports);
    return module.exports;
}

test("background keeps launchPending=false for repeated updates of an already claimed launch", async () => {
    const { resolveLaunchPending } = await loadBackgroundHelpers();

    const existingMetadata = {
        bridgeBaseUrl: "http://127.0.0.1:4545",
        claimToken: "claim-1",
        sessionId: "api",
        isTemporary: false,
        launchPending: false
    };
    const launchContext = {
        bridgeBaseUrl: "http://127.0.0.1:4545",
        claimToken: "claim-1",
        sessionId: "api",
        isTemporary: false
    };

    assert.equal(resolveLaunchPending(existingMetadata, launchContext), false);
    assert.equal(resolveLaunchPending(existingMetadata, { ...launchContext, claimToken: "claim-2" }), true);
});
