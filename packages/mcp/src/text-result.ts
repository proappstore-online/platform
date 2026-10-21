/** A plain-text tool result, shared by the tool modules that return one. */
export type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
export const text = (s: string, isError = false): Text => ({ content: [{ type: "text" as const, text: s }], ...(isError ? { isError: true } : {}) });
