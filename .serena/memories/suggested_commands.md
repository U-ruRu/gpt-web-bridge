# Suggested Commands
- `npm install` — install dependencies.
- `npm run build` — compile TypeScript into `dist/`.
- `npm run start:bridge` — start the debug HTTP bridge on localhost.
- `npm run start:mcp` — start the stdio MCP server.
- `npm test` — build and run the Node test suite.
- `Get-Content %LOCALAPPDATA%\chatgpt-web-bridge\logs\<sessionId>-runtime.log` — inspect runtime logs on Windows.
- `rg --files` / `rg "<pattern>"` — fast file or text search in the repo.
- Firefox manual load: open `about:debugging#/runtime/this-firefox`, then load `extension/manifest.json` as a temporary add-on.