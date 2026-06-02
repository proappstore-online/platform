/**
 * Pure builders for the message that frames a single agent turn. Kept out of the
 * DO so the framing logic is unit-testable without storage.
 */

import type { Message, Role, Ticket } from './types.ts';
import { uuid } from './store.ts';

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

  if (role === 'Dev') {
    const ba = lastFrom('BA');
    if (ba) context += `\n\n## BA analysis\n${ba}`;
    if (ticket.status === 'qa-failed' || ticket.iterations > 0) {
      const qa = lastFrom('QA');
      if (qa) context += `\n\n## QA found these issues — fix them\n${qa}`;
    }
    context += `\n\nThe app id is "${slug}". Implement or modify the app to satisfy the spec, using your tools. If unsure about a PAS SDK API/signature, call \`read_docs\` (e.g. topic "database") to confirm from the official docs BEFORE writing it — don't guess. Write the code with your file tools (batch_write_files) BEFORE explaining — keep prose brief. Do not end your turn after only reading/planning; you must actually create or edit the files. If \`src/main.tsx\` imports a file that doesn't exist (e.g. \`./App\`), create it.

CRITICAL — ship it for real: after writing files you MUST call \`provision_app\` to push, then call \`get_deploy_status\` to confirm the build is GREEN. If it reports "Build FAILED", the code did NOT deploy — read the compiler error, fix it, and call provision_app again. Repeat until the build succeeds. Do NOT end your turn on a red or unverified build, and never claim "done/deployed" unless get_deploy_status returned SUCCESS. (Note: the \`useProAuth\` hook's \`signIn\` is zero-arg — to pass a provider, call \`app.auth.signIn(provider)\` directly, not the hook's \`signIn(provider)\`.)`;
  } else if (role === 'QA') {
    const ba = lastFrom('BA');
    if (ba) context += `\n\n## Spec to verify\n${ba}`;
    context += `\n\nThe app id is "${slug}". Review the implemented code against the spec. You MUST call \`get_deploy_status\`: if the build/deploy did not SUCCEED, that is an automatic FAIL — code that doesn't compile is a fail no matter how correct it reads. Quote the build error in your findings. Only PASS when the spec is met AND the build is green. Report PASS or FAIL with specific findings.`;
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
