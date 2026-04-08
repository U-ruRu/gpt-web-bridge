# Style And Conventions
- TypeScript runtime code uses 4-space indentation and named helper functions rather than inline complexity.
- Runtime and MCP code favor small explicit helpers for normalization and URL/state handling.
- Extension code is plain JavaScript in a self-invoking script and relies on DOM selectors plus background-message RPC.
- Tests use the Node built-in test runner with `assert/strict` and should cover bridge/runtime behavior, MCP behavior, and extension regressions when possible.