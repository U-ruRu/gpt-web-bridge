import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

async function loadBackgroundHelpers() {
    const source = await readFile(join(projectDir, "extension", "background.js"), "utf8");
    const normalizeAgentConfigMatch = source.match(/function normalizeAgentConfig\(value\) \{[\s\S]*?\n\}/);
    const normalizeHttpServerUrlMatch = source.match(/function normalizeHttpServerUrl\(value\) \{[\s\S]*?\n\}/);
    const toAgentWebSocketUrlMatch = source.match(/function toAgentWebSocketUrl\(serverUrl\) \{[\s\S]*?\n\}/);
    const normalizeNullableStringMatch = source.match(/function normalizeNullableString\(value\) \{[\s\S]*?\n\}/);
    const isPlainObjectMatch = source.match(/function isPlainObject\(value\) \{[\s\S]*?\n\}/);

    assert.ok(normalizeAgentConfigMatch, "normalizeAgentConfig() should be declared in background.js");
    assert.ok(normalizeHttpServerUrlMatch, "normalizeHttpServerUrl() should be declared in background.js");
    assert.ok(toAgentWebSocketUrlMatch, "toAgentWebSocketUrl() should be declared in background.js");
    assert.ok(normalizeNullableStringMatch, "normalizeNullableString() should be declared in background.js");
    assert.ok(isPlainObjectMatch, "isPlainObject() should be declared in background.js");

    const module = { exports: {} };
    const factory = new Function(
        "module",
        "exports",
        `"use strict"; ${normalizeNullableStringMatch[0]} ${isPlainObjectMatch[0]} ${normalizeHttpServerUrlMatch[0]} ${normalizeAgentConfigMatch[0]} ${toAgentWebSocketUrlMatch[0]} module.exports = { normalizeAgentConfig, toAgentWebSocketUrl };`
    );
    factory(module, module.exports);
    return module.exports;
}

test("background normalizes a valid remote agent configuration", async () => {
    const { normalizeAgentConfig } = await loadBackgroundHelpers();

    assert.deepEqual(
        normalizeAgentConfig({
            serverUrl: " https://bridge.example.com/api/ ",
            serverAccessToken: " server-secret ",
            userToken: " user-secret "
        }),
        {
            serverUrl: "https://bridge.example.com/api",
            serverAccessToken: "server-secret",
            userToken: "user-secret"
        }
    );

    assert.equal(
        normalizeAgentConfig({
            serverUrl: "ftp://example.com",
            serverAccessToken: "secret",
            userToken: "user"
        }),
        null
    );
});

test("background derives the agent websocket URL from the configured server URL", async () => {
    const { toAgentWebSocketUrl } = await loadBackgroundHelpers();

    assert.equal(
        toAgentWebSocketUrl("https://bridge.example.com"),
        "wss://bridge.example.com/agent/ws"
    );
    assert.equal(
        toAgentWebSocketUrl("http://127.0.0.1:8787/api"),
        "ws://127.0.0.1:8787/api/agent/ws"
    );
});
