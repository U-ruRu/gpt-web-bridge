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

async function loadTypingDelayConfig() {
    const source = await readFile(join(projectDir, "extension", "content-script.js"), "utf8");
    const baseMinMatch = source.match(/const TYPING_DELAY_BASE_MIN_MS = (\d+);/);
    const baseMaxMatch = source.match(/const TYPING_DELAY_BASE_MAX_MS = (\d+);/);
    const spaceBonusMatch = source.match(/const TYPING_DELAY_SPACE_BONUS_MS = (\d+);/);
    const punctuationBonusMatch = source.match(/const TYPING_DELAY_PUNCTUATION_BONUS_MS = (\d+);/);
    const defaultMultiplierMatch = source.match(/const DEFAULT_TYPING_SPEED_MULTIPLIER = (\d+);/);
    const normalizeTypingSpeedMultiplierMatch = source.match(/function normalizeTypingSpeedMultiplier\(value\) \{[\s\S]*?\n    \}/);
    const randomBetweenMatch = source.match(/function randomBetween\(min, max\) \{[\s\S]*?\n    \}/);
    const getTypingDelayMatch = source.match(/function getTypingDelay\(char, typingSpeedMultiplier = DEFAULT_TYPING_SPEED_MULTIPLIER\) \{[\s\S]*?\n    \}/);

    assert.ok(baseMinMatch, "TYPING_DELAY_BASE_MIN_MS should be declared in content-script.js");
    assert.ok(baseMaxMatch, "TYPING_DELAY_BASE_MAX_MS should be declared in content-script.js");
    assert.ok(spaceBonusMatch, "TYPING_DELAY_SPACE_BONUS_MS should be declared in content-script.js");
    assert.ok(punctuationBonusMatch, "TYPING_DELAY_PUNCTUATION_BONUS_MS should be declared in content-script.js");
    assert.ok(defaultMultiplierMatch, "DEFAULT_TYPING_SPEED_MULTIPLIER should be declared in content-script.js");
    assert.ok(normalizeTypingSpeedMultiplierMatch, "normalizeTypingSpeedMultiplier() should be declared in content-script.js");
    assert.ok(randomBetweenMatch, "randomBetween() should be declared in content-script.js");
    assert.ok(getTypingDelayMatch, "getTypingDelay() should be declared in content-script.js");

    const module = { exports: {} };
    const factory = new Function(
        "module",
        "exports",
        `"use strict";
        const TYPING_DELAY_BASE_MIN_MS = ${Number(baseMinMatch[1])};
        const TYPING_DELAY_BASE_MAX_MS = ${Number(baseMaxMatch[1])};
        const TYPING_DELAY_SPACE_BONUS_MS = ${Number(spaceBonusMatch[1])};
        const TYPING_DELAY_PUNCTUATION_BONUS_MS = ${Number(punctuationBonusMatch[1])};
        const DEFAULT_TYPING_SPEED_MULTIPLIER = ${Number(defaultMultiplierMatch[1])};
        ${normalizeTypingSpeedMultiplierMatch[0]}
        ${randomBetweenMatch[0]}
        ${getTypingDelayMatch[0]}
        module.exports = {
            baseMinMs: TYPING_DELAY_BASE_MIN_MS,
            baseMaxMs: TYPING_DELAY_BASE_MAX_MS,
            spaceBonusMs: TYPING_DELAY_SPACE_BONUS_MS,
            punctuationBonusMs: TYPING_DELAY_PUNCTUATION_BONUS_MS,
            defaultMultiplier: DEFAULT_TYPING_SPEED_MULTIPLIER,
            normalizeTypingSpeedMultiplier,
            getTypingDelay
        };`
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

test("content script typing delays respect the configured speed multiplier", async () => {
    const config = await loadTypingDelayConfig();

    assert.deepEqual(
        {
            baseMinMs: config.baseMinMs,
            baseMaxMs: config.baseMaxMs,
            spaceBonusMs: config.spaceBonusMs,
            punctuationBonusMs: config.punctuationBonusMs,
            defaultMultiplier: config.defaultMultiplier
        },
        {
        baseMinMs: 45,
        baseMaxMs: 170,
        spaceBonusMs: 90,
        punctuationBonusMs: 140,
            defaultMultiplier: 4
        }
    );

    assert.equal(config.normalizeTypingSpeedMultiplier("2,5"), 2.5);
    assert.equal(config.normalizeTypingSpeedMultiplier("invalid"), 4);

    const originalRandom = Math.random;
    try {
        Math.random = () => 0;
        assert.equal(config.getTypingDelay("a", 1), 45);
        assert.equal(config.getTypingDelay("a", 4), 11);
        assert.equal(config.getTypingDelay(" ", 4), 34);
        assert.equal(config.getTypingDelay(".", 4), 46);
    } finally {
        Math.random = originalRandom;
    }
});
