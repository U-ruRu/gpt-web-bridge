import test from "node:test";
import assert from "node:assert/strict";
import { getOpenUrlProcessConfig } from "../dist/bridge/server.js";

test("Windows openExternalUrl uses PowerShell and passes the URL through an environment variable", () => {
    const targetUrl = "https://chatgpt.com/#bridgeClaim=test&bridgePort=4545&bridgeSessionId=api";
    const config = getOpenUrlProcessConfig(targetUrl, "win32", {
        SYSTEMROOT: "C:\\Windows"
    });

    assert.equal(config.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(config.args.slice(0, 5), [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command"
    ]);
    assert.match(config.args[5], /Start-Process -FilePath \$env:CHATGPT_WEB_BRIDGE_TARGET_URL/);
    assert.equal(config.env.CHATGPT_WEB_BRIDGE_TARGET_URL, targetUrl);
});
