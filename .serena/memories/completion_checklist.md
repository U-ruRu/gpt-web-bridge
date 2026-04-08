# Completion Checklist
- Run `npm test` after changes; it performs the TypeScript build and the test suite.
- If extension files changed, reload the temporary Firefox add-on from `about:debugging` before manual verification.
- For timeout/debug issues, inspect `%LOCALAPPDATA%/chatgpt-web-bridge/logs/<sessionId>-runtime.log` and Firefox `browser.storage.local.get("debugLogs")` from the background page console.
- When changing launch/binding logic, verify both fresh chat and restore-to-existing-chat flows.