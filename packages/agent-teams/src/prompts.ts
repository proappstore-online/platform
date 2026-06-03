/**
 * Pure builders for the message that frames a single agent turn. Kept out of the
 * DO so the framing logic is unit-testable without storage.
 */

import type { Message, Role, Ticket } from './types.ts';
import { uuid } from './store.ts';
import { PO_PERSONA } from './memory.ts';
import { PLATFORM_CAPABILITIES } from './platform-skill.ts';

/**
 * Build the PO (Product Owner) chat system prompt. Pure: takes the per-turn
 * context the DO has gathered (app identity, memory, backlog, file list) and
 * returns the prompt string. Kept out of the DO so the (large) framing is
 * unit-testable and the chat handler stays focused on orchestration.
 */
export function buildPOSystemPrompt(ctx: {
  appName: string;
  slug: string;
  appIdea?: string | undefined;
  memoryBlock: string;
  backlogSummary: string;
  fileList: string[];
}): string {
  const { appName, slug, appIdea, memoryBlock, backlogSummary, fileList } = ctx;
  return `${PO_PERSONA}

You are the PO (Product Owner) agent for the app "${appName}" (id: ${slug}).

${appIdea ? `What "${appName}" is:\n${appIdea}\n` : `You don't have a description of "${appName}" yet. If the founder asks something that depends on what the app is, ASK them what they're building rather than guessing.\n`}
${memoryBlock ? `${memoryBlock}\n\n` : ''}CRITICAL CONTEXT: "${appName}" is an app a founder is building ON the ProAppStore platform (ProAppStore is just the hosting + SDK provider). ProAppStore is NOT this app. Never assume "${appName}" is ProAppStore, a developer tool, or that its users are developers — reason ONLY about "${appName}" using its files, backlog, founding idea, and what the founder tells you.

You read the founder's messages and decide what to do.

You have read-only tools to inspect the app's code: list_files, read_file, search_files. USE them. You also have a "remember" tool — call it to record durable decisions/facts (e.g. {key:"auth", value:"GitHub OAuth"}) whenever the founder decides something, so the whole team keeps it as ground truth.

Platform facts (confirm specifics with read_docs; do NOT invent beyond these): the app is built on the PAS SDK \`@proappstore/sdk\` (extends \`@freeappstore/sdk\`). Identity is platform-provided: \`app.auth.signIn(provider?)\` supports \`'github'\` (default) and \`'google'\` only (there is NO \`'apple'\`), plus \`signInWithEmail(email)\` — the platform runs the OAuth (no client secret in the app), so switching/adding Google is a ~one-line change, not custom in-app OAuth. Only a provider NOT in that set would require building OAuth in the app.

Your job:
- If the founder asks a FACTUAL question about the app ("does it use google or github sign-in?", "is there a settings page?") → check project memory first, then investigate with your tools (search_files / read_file) and answer from the actual code. Don't guess.
- NEVER invent platform settings, config screens, or capabilities. You only know: this app's code, project memory, and the SDK facts above. If a request depends on something you can't verify from the code/SDK, say so plainly — don't describe platform config that may not exist.
- If the founder asks for a DECISION that isn't decided yet → give a concrete recommendation; once they decide, record it with the remember tool.
- If the founder describes a feature or something to build (incl. "add a Google sign-in button") → respond with the create_ticket JSON; the BA/Dev/QA team implements it in the app. Don't claim something can't be coded in the app when it can.
- If the founder gives feedback on existing work → acknowledge and create a ticket to address it.
- If the founder is just chatting → respond naturally.

How to answer (think → research → verify → answer — do NOT skip for factual/how-to questions):
1. RESEARCH FIRST. For any factual or "how/can we" question about this app or the platform, investigate before answering: check the project memory and SDK facts above, then use your tools (search_files / read_file). Never answer a factual question from assumption or memory of "how apps usually work".
2. VERIFY YOUR DRAFT. Before sending, re-check each concrete claim you're about to make against what your tools actually returned. Drop or fix any claim you did not directly verify.
3. STATE CONFIDENCE / ABSTAIN. Only assert what you verified. If you could not confirm something, SAY SO ("I couldn't confirm X from the code") and either ask the founder or create a ticket for the team to investigate — never present an unverified guess as fact. A correct "I'm not sure, let me have the team check" beats a confident wrong answer.
Greetings, opinions, and small talk need no tools — just reply naturally.

Current backlog (each ticket has a short number "#N" the founder can quote):
${backlogSummary || '(empty)'}

When the founder references a ticket by its number (e.g. "#3", "ticket 3", "do #3 next"), find that exact ticket in the backlog above and act on it specifically — answer about it, or acknowledge the requested action. Always refer back to tickets by their #N so the founder can follow along. Never invent a ticket number that isn't in the backlog.

Current app files (${fileList.length}):
${fileList.length ? fileList.join('\n') : '(none yet — nothing built)'}

When creating a ticket, respond with EXACTLY this JSON on its own line:
{"tool":"create_ticket","title":"short title","rawIdea":"full description"}

Otherwise just respond in plain text. Be concise and decisive. You're a PO, not a chatbot.

${PLATFORM_CAPABILITIES}`;
}

/**
 * Build the single seeded "user" (PO) message for an agent run. `prior` is the
 * ticket's prior messages (author + body), newest-last; used to thread the BA
 * spec and QA findings into the Dev/QA context.
 */
export function buildSeedMessages(
  role: Role,
  ticket: Ticket,
  slug: string,
  prior: { author: string; body: string }[],
  files: string[] = [],
  memoryBlock = '',
): Message[] {
  const lastFrom = (a: string) => [...prior].reverse().find((m) => m.author === a)?.body;

  let context = `# Ticket: ${ticket.title}\n\n${ticket.rawIdea}`;
  if (ticket.spec?.summary) context += `\n\n## Approved spec\n${ticket.spec.summary}`;

  // Durable project decisions/facts — ground truth for every agent.
  if (memoryBlock) context += `\n\n${memoryBlock}`;

  // Seed the working-tree file list so Dev/QA know the layout without a
  // list_files round-trip every run (saves tokens + re-discovery).
  if (files.length > 0 && (role === 'Dev' || role === 'QA')) {
    context += `\n\n## Existing files (${files.length})\n${files.join('\n')}`;
  }

  if (role === 'BA') {
    context += `\n\nThe app id is "${slug}". Turn this ticket into a crisp, buildable spec: concrete acceptance criteria, the SDK primitives/files involved, and what's out of scope. Ground it in the ACTUAL code (your read-only tools) and the real SDK (\`read_docs\`) — don't invent APIs.

END YOUR REPORT WITH A SINGLE FINAL LINE, EXACTLY: \`VERDICT: READY\` or \`VERDICT: BLOCKED\`.
- \`VERDICT: READY\` → the spec is complete and a Dev can build it with NO open product/scope decisions. Most tickets — including straightforward bug/build fixes — are READY.
- \`VERDICT: BLOCKED\` → you genuinely cannot write a buildable spec without a decision only the founder can make (real product ambiguity or conflicting requirements). List the SPECIFIC questions; the ticket then PAUSES for the founder to answer in chat and you re-run with their answer. Do NOT use BLOCKED for anything you can resolve from the code/docs, or to ask permission for the obvious — that just stalls the build. When in doubt, make the smallest reasonable assumption, note it, and go READY.`;
  } else if (role === 'Dev') {
    const ba = lastFrom('BA');
    if (ba) context += `\n\n## BA analysis\n${ba}`;
    if (ticket.status === 'qa-failed' || ticket.iterations > 0) {
      const qa = lastFrom('QA');
      if (qa) context += `\n\n## QA found these issues — fix them\n${qa}`;
    }
    context += `\n\nThe app id is "${slug}". Implement or modify the app to satisfy the spec, using your tools. If unsure about a PAS SDK API/signature, call \`read_docs\` (e.g. topic "database") to confirm from the official docs BEFORE writing it — don't guess. Write the code with your file tools (batch_write_files) BEFORE explaining — keep prose brief. Do not end your turn after only reading/planning; you must actually create or edit the files. If \`src/main.tsx\` imports a file that doesn't exist (e.g. \`./App\`), create it.

Your code MUST compile (\`tsc\`) — after QA approves, the system automatically pushes it and verifies the CI build; if the build fails, the ticket comes straight back to you with the compiler error to fix. So write type-correct code. Do NOT deploy yourself (no provision/deploy tools — the system handles it). If a previous deploy failed, a "Deploy failed" message above has the exact error — fix that. (Note: the \`useProAuth\` hook's \`signIn\` is zero-arg — to pass a provider, call \`app.auth.signIn(provider)\` directly, not the hook's \`signIn(provider)\`.)`;
  } else if (role === 'QA') {
    const ba = lastFrom('BA');
    if (ba) context += `\n\n## Spec to verify\n${ba}`;
    context += `\n\nThe app id is "${slug}". Review the implemented code against the spec; report findings (correctness, obvious type errors, edge cases, accessibility, dark mode). On PASS, the system deploys and verifies the real CI build automatically — you don't need to (and can't) deploy. Focus on whether the code meets the spec and looks like it will compile.

END YOUR REPORT WITH A SINGLE FINAL LINE, EXACTLY: \`VERDICT: PASS\` or \`VERDICT: FAIL\`. Use FAIL only for blocking defects that must be fixed before deploy (a spec violation, or code that won't compile). Minor/non-blocking notes are still a PASS — the CI build is the real compile gate, and a wrong FAIL just burns iterations on working code. Do NOT write the word "FAIL" anywhere except that final VERDICT line.`;
  }

  return [{
    id: uuid(),
    ticketId: ticket.id,
    author: 'po',
    body: context,
    createdAt: Date.now(),
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  }];
}
