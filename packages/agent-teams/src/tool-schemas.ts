/**
 * Canonical spine tool schemas (JSON Schema), shared by both runtime adapters.
 * cf-native wraps each as an Anthropic tool (input_schema); openai-responses
 * wraps it as a function tool (parameters). These match project-tools.ts in the
 * MCP server.
 */

export interface ToolSchema {
  description: string;
  parameters: Record<string, unknown>;
}

// Deployment (scaffold/provision/deploy-status) is NOT an agent tool — it's a
// deterministic system stage (ProjectDO.runDeploy) that runs after QA approves.
export const TOOL_SCHEMAS: Record<string, ToolSchema> = {
  write_file: {
    description: 'Create or overwrite a file in the app GitHub repo.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        path: { type: 'string', description: 'File path relative to repo root' },
        content: { type: 'string', description: 'Full file content' },
        message: { type: 'string', description: 'Commit message' },
      },
      required: ['app_id', 'path', 'content'],
      additionalProperties: false,
    },
  },
  read_file: {
    description: 'Read a file from the app GitHub repo.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['app_id', 'path'],
      additionalProperties: false,
    },
  },
  list_files: {
    description: 'List files in the app GitHub repo.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        path: { type: 'string', description: 'Subdirectory (default: root)' },
      },
      required: ['app_id'],
      additionalProperties: false,
    },
  },
  search_files: {
    description: 'Search for text across all files in the app repo.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['app_id', 'query'],
      additionalProperties: false,
    },
  },
  batch_write_files: {
    description: 'Write multiple files in a single commit.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
        message: { type: 'string', description: 'Commit message' },
      },
      required: ['app_id', 'files', 'message'],
      additionalProperties: false,
    },
  },
  read_docs: {
    description: 'Read the official ProAppStore platform/SDK docs (skills.md) — the real API reference. Pass a topic (e.g. "database", "rooms", "subscription") to get just that section. Use it to confirm a real SDK capability/signature before writing or reviewing code.',
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'optional section/keyword to focus on' } },
      additionalProperties: false,
    },
  },
};
