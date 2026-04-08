# chatgpt-web-bridge
- Purpose: local bridge that automates `chatgpt.com` through a Firefox extension and exposes both a debug HTTP bridge and stdio MCP tools.
- Tech stack: TypeScript/Node.js for runtime and MCP server, plain JavaScript for the Firefox extension, Node built-in test runner for tests.
- Main structure: `src/bridge` contains runtime/server/types, `src/mcp/server.ts` registers stdio MCP tools, `extension/` contains Firefox background/content scripts, `tests/` contains Node integration tests.
- Runtime model: one stdio MCP process owns one bridge port, one logical session, and one claimed ChatGPT automation tab.
- Persistence: runtime stores logs, sessions, and chat history under `%LOCALAPPDATA%/chatgpt-web-bridge` on Windows unless `--data-dir` overrides it.
- Recent behavior note: launch URLs now keep the canonical `/c/<chatId>` route intact and carry bridge binding data in the URL hash; content script treats localized ChatGPT home paths like `/ru-RU/` as valid fresh-chat pages.