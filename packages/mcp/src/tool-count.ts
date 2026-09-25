/**
 * The size of the MCP tool surfaces, held to a number (#157 step 4).
 *
 * The shared `/mcp` endpoint used to register every app's tools for every
 * connection — 824 tools from 19 apps, 485 KB of `tools/list` — so its size
 * depended on how many apps existed. It now registers no app tools at all and
 * reaches them through `list_app_tools` / `call_app_tool`, which makes its size
 * a constant. `tool-count.test.ts` asserts these against the REAL registration
 * path (`PasMcpAgent.init`) with 0 and 500 synthetic app tools, so adding a
 * `server.tool(...)` to any platform registrar without updating the constant
 * fails the build, and the surface cannot quietly grow back.
 */

/** Tools on the shared /mcp endpoint. Independent of how many apps exist. */
export const MCP_SHARED_TOOL_COUNT = 54;

/** Fixed tools on /mcp/apps/<id> besides that app's own tools (`whoami`, `mcp_audit_log`). */
export const MCP_APP_SCOPED_FIXED = 2;
