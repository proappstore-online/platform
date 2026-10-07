/** A plain-text tool result, shared by the tool modules that return one. */
export type Text = { content: { type: "text"; text: string }[] };
export const text = (s: string): Text => ({ content: [{ type: "text" as const, text: s }] });
