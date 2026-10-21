#!/usr/bin/env node
// Launch the installed, pinned bridge. Never download/execute an unreviewed
// latest package or let an npx installation prompt consume the MCP stdin stream.
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const child = spawn(process.execPath, [
  require.resolve('mcp-remote/dist/proxy.js'),
  'https://mcp.proappstore.online/mcp',
], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
  console.error(`Unable to start PAS MCP: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
});
