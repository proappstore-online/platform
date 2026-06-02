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
): Message[] {
  const lastFrom = (a: string) => [...prior].reverse().find((m) => m.author === a)?.body;

  let context = `# Ticket: ${ticket.title}\n\n${ticket.rawIdea}`;
  if (ticket.spec?.summary) context += `\n\n## Approved spec\n${ticket.spec.summary}`;

  if (role === 'Dev') {
    const ba = lastFrom('BA');
    if (ba) context += `\n\n## BA analysis\n${ba}`;
    if (ticket.status === 'qa-failed' || ticket.iterations > 0) {
      const qa = lastFrom('QA');
      if (qa) context += `\n\n## QA found these issues — fix them\n${qa}`;
    }
    context += `\n\nThe app id is "${slug}". Implement or modify the app to satisfy the spec, using your tools.`;
  } else if (role === 'QA') {
    const ba = lastFrom('BA');
    if (ba) context += `\n\n## Spec to verify\n${ba}`;
    context += `\n\nThe app id is "${slug}". Review the implemented code and report PASS or FAIL with specific findings.`;
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
