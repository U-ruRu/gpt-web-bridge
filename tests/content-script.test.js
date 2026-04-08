import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

async function loadContentScriptHelpers() {
    const source = await readFile(join(projectDir, "extension", "content-script.js"), "utf8");
    const homeUrlMatch = source.match(/const CHATGPT_HOME_URL = "([^"]+)";/);
    const isChatHomePathMatch = source.match(/function isChatHomePath\(pathname\) \{[\s\S]*?\n    \}/);
    const isChatHomeMatch = source.match(/function isChatHome\(url\) \{[\s\S]*?\n    \}/);

    assert.ok(homeUrlMatch, "CHATGPT_HOME_URL should be declared in content-script.js");
    assert.ok(isChatHomePathMatch, "isChatHomePath() should be declared in content-script.js");
    assert.ok(isChatHomeMatch, "isChatHome() should be declared in content-script.js");

    const module = { exports: {} };
    const factory = new Function(
        "module",
        "exports",
        `"use strict"; const CHATGPT_HOME_URL = ${JSON.stringify(homeUrlMatch[1])}; ${isChatHomePathMatch[0]} ${isChatHomeMatch[0]} module.exports = { isChatHome, isChatHomePath };`
    );
    factory(module, module.exports);
    return module.exports;
}

test("content script treats localized ChatGPT home URLs as a fresh chat page", async () => {
    const { isChatHome } = await loadContentScriptHelpers();

    assert.equal(isChatHome("https://chatgpt.com/"), true);
    assert.equal(isChatHome("https://chatgpt.com/ru-RU/"), true);
    assert.equal(isChatHome("https://chatgpt.com/ru-RU/?temporary-chat=true"), true);
    assert.equal(isChatHome("https://chatgpt.com/kk/#bridgeClaim=test"), true);
    assert.equal(isChatHome("https://chatgpt.com/c/69d34509-fc88-8391-a2ee-ba71df5a462b"), false);
});
