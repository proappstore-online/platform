#!/usr/bin/env node
// Thin wrapper that launches mcp-remote pointing to the ProAppStore MCP server.
// This exists so the MCP Registry can discover and install the server via npm.
const { execFileSync } = require('child_process');
try {
  execFileSync('npx', ['mcp-remote', 'https://mcp.proappstore.online/mcp'], { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status || 1);
}
