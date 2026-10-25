import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

const READS = new Set(`whoami mcp_audit_log list_apps deploy_status schema_status list_scheduled_runs
list_templates app_info platform_guide sdk_reference recipe list_app_tools provisioning_status
read_file list_files search_files get_deploy_status list_projects get_project list_tickets list_agents
get_project_files agent_project_status agent_board agent_activity agent_ticket_detail agent_cost
qa_list_flows qa_list_runs qa_run_artifacts qa_flow_playwright inspect_admin_console
list_admin_capabilities preview_admin_console propose_admin_update validate_admin_security
ownership_status find_apps list_oidc_session_grants list_enquiries get_enquiry`.split(/\s+/));

const DESTRUCTIVE = new Set(`call_app_tool provision_pas_app scaffold_app write_file delete_file
provision_app publish_app batch_write_files write_project_files delete_project_files deploy_project
set_project_budget set_project_running set_model update_ticket build_knowledge_base qa_save_flow
qa_delete_flow apply_admin_update respond_ownership_transfer resolve_ownership_request
create_oidc_session_grant revoke_oidc_session_grant`.split(/\s+/));

/** A shared tool's behavior is fixed even when one invocation is a dry-run. */
function platformToolAnnotations(name: string): ToolAnnotations {
  const read = READS.has(name);
  return { readOnlyHint: read, destructiveHint: !read && DESTRUCTIVE.has(name), idempotentHint: read, openWorldHint: true };
}

/** Manifest operations, not a name like "get_*", determine app-tool behavior. */
export function appToolAnnotations(operation: string): ToolAnnotations {
  const read = operation === "query";
  return { readOnlyHint: read, destructiveHint: !read, idempotentHint: read, openWorldHint: false };
}

/** Centralize metadata so legacy registrars cannot silently omit annotations.
 * Explicit annotations (including app-manifest operations) take precedence. */
export function installToolMetadata(server: McpServer): void {
  const original = server.tool.bind(server) as (...args: unknown[]) => unknown;
  server.tool = ((...args: unknown[]) => {
    const handler = args.pop();
    const last = args[args.length - 1];
    const explicit = last && typeof last === "object" &&
      ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].some((key) => key in last);
    if (!explicit) args.push(platformToolAnnotations(String(args[0])));
    return original(...args, handler);
  }) as McpServer["tool"];
}
