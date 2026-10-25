import type { ProjectHost } from './project-host.ts';
import { json } from './store.ts';
import { recallMemory } from './project-store.ts';
import { listShares, createShare, revokeShare, accessKbViaShare, accessKbFileViaShare, type CreateShareInput } from './kb-shares.ts';
import { costDetail } from './activity-log.ts';
import { assertAccess, assertRole, helloFrame } from './project-access.ts';
import { listProjectFiles, getProjectFile, writeProjectFiles, deleteProjectFiles, syncFromGitHub } from './project-workspace.ts';
import { addMemory, forgetMemory } from './project-memory.ts';
import { listMessages, addMessage } from './project-messages.ts';
import { setPlayState, directDeploy, runAgent } from './project-pipeline.ts';
import { listTickets, getTicket, createTicket, updateTicket, deleteTicket, transitionTicket } from './project-tickets.ts';
import { openChatStream, clearChat, getChatHistory, handleChatTurn, buildKnowledgeBase } from './project-chat.ts';
import { getProject, initProject, getRoles, getAgents, setBudget, setRoles } from './project-settings.ts';
import { getCostSummary, clearActivity, getActivity, generateListing, triggerTestRun, getTestHistory, ingestTestResults } from './project-reports.ts';

/** The HTTP + WebSocket route table the Durable Object's `fetch` delegates to. */
export async function handleRequest(h: ProjectHost, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // WebSocket upgrade (hibernation-safe, with ownership check)
  if (request.headers.get('Upgrade') === 'websocket') {
    const ownerErr = assertAccess(h, request);
    if (ownerErr) return ownerErr;
    const pair = new WebSocketPair();
    h.state.acceptWebSocket(pair[1]);
    // #7: keepalive that never wakes a hibernated DO — a client "ping" text
    // frame is answered "pong" by the runtime. Idempotent per instance.
    try { h.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch { /* older runtime */ }
    // #7: a snapshot the moment the socket opens, so a (re)connecting console
    // resyncs play state and deploy status without a REST round-trip and can
    // tell a live socket from a dead one.
    try { pair[1].send(JSON.stringify(helloFrame(h))); } catch { /* client gone already */ }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Init is special: only checks ownership if project already exists
  if (path === '/project' && request.method === 'PUT') return initProject(h, request);

  // KB share access is PUBLIC — the share ID is the auth token.
  // Must be checked before the ownership gate.
  const shareAccessMatch = path.match(/^\/kb\/share\/([a-zA-Z0-9_-]+)$/);
  if (shareAccessMatch) return accessKbViaShare(h.state.storage.sql, shareAccessMatch[1]!);
  const shareFileMatch = path.match(/^\/kb\/share\/([a-zA-Z0-9_-]+)\/file$/);
  if (shareFileMatch) return accessKbFileViaShare(h.state.storage.sql, shareFileMatch[1]!, new URL(request.url).searchParams.get('path') ?? '');

  // All other routes require membership…
  const ownerErr = assertAccess(h, request);
  if (ownerErr) return ownerErr;
  // …and privileged routes require a sufficient role (#79).
  const roleErr = assertRole(h, request, path);
  if (roleErr) return roleErr;

  // REST routes
  if (path === '/project' && request.method === 'GET') return getProject(h);
  if (path === '/project/play' && request.method === 'POST') return setPlayState(h, 'running');
  if (path === '/project/pause' && request.method === 'POST') return setPlayState(h, 'paused');
  if (path === '/project/research' && request.method === 'POST') return buildKnowledgeBase(h);

  if (path === '/roles' && request.method === 'GET') return getRoles(h);
  if (path === '/roles' && request.method === 'PUT') return setRoles(h, request);
  if (path === '/agents' && request.method === 'GET') return getAgents(h);
  if (path === '/budget' && request.method === 'PUT') return setBudget(h, request);

  if (path === '/chat' && request.method === 'POST') return handleChatTurn(h, request);
  if (path === '/chat/stream' && request.method === 'GET') return openChatStream(h, request);
  if (path === '/chat/history' && request.method === 'GET') return getChatHistory(h, request);
  if (path === '/chat/history' && request.method === 'DELETE') return clearChat(h, request);

  if (path === '/tickets' && request.method === 'GET') return listTickets(h);
  if (path === '/tickets' && request.method === 'POST') return createTicket(h, request);

  const ticketMatch = path.match(/^\/tickets\/([a-f0-9-]+)$/);
  if (ticketMatch) {
    const ticketId = ticketMatch[1]!;
    if (request.method === 'GET') return getTicket(h, ticketId);
    if (request.method === 'PATCH') return updateTicket(h, ticketId, request);
    if (request.method === 'DELETE') return deleteTicket(h, ticketId);
  }

  const transitionMatch = path.match(/^\/tickets\/([a-f0-9-]+)\/transition$/);
  if (transitionMatch && request.method === 'POST') {
    return transitionTicket(h, transitionMatch[1]!, request);
  }

  const messagesMatch = path.match(/^\/tickets\/([a-f0-9-]+)\/messages$/);
  if (messagesMatch) {
    if (request.method === 'GET') return listMessages(h, messagesMatch[1]!);
    if (request.method === 'POST') return addMessage(h, messagesMatch[1]!, request);
  }

  const runMatch = path.match(/^\/tickets\/([a-f0-9-]+)\/run$/);
  if (runMatch && request.method === 'POST') {
    return runAgent(h, runMatch[1]!, request);
  }

  if (path === '/generate-listing' && request.method === 'POST') return generateListing(h, request);
  if (path === '/run-tests' && request.method === 'POST') return triggerTestRun(h);
  if (path === '/test-history' && request.method === 'GET') return getTestHistory(h);
  if (path === '/test-history' && request.method === 'POST') return ingestTestResults(h, request);
  if (path === '/cost' && request.method === 'GET') return getCostSummary(h);
  if (path === '/cost/detail' && request.method === 'GET') return json(costDetail(h.state.storage.sql));
  if (path === '/activity' && request.method === 'GET') return getActivity(h);
  if (path === '/activity' && request.method === 'DELETE') return clearActivity(h);

  if (path === '/memory' && request.method === 'GET') return json({ memory: recallMemory(h.state.storage.sql) });
  if (path === '/memory' && request.method === 'POST') return addMemory(h, request);
  const memMatch = path.match(/^\/memory\/([a-f0-9-]+)$/);
  if (memMatch && request.method === 'DELETE') return forgetMemory(h, memMatch[1]!);

  if (path === '/sync' && request.method === 'POST') {
    const r = await syncFromGitHub(h, 'manual');
    return json({ ok: true, ...r });
  }

  if (path === '/files' && request.method === 'GET') return listProjectFiles(h);
  if (path === '/files/content' && request.method === 'GET') {
    return getProjectFile(h, new URL(request.url).searchParams.get('path') ?? '');
  }
  // Direct (agent-free) build: an external brain writes the working tree itself.
  if (path === '/files' && request.method === 'POST') return writeProjectFiles(h, request);
  if (path === '/files' && request.method === 'DELETE') return deleteProjectFiles(h, request);
  if (path === '/deploy' && request.method === 'POST') return directDeploy(h);

  // KB share link management (owner only)
  if (path === '/shares' && request.method === 'GET') return listShares(h.state.storage.sql);
  if (path === '/shares' && request.method === 'POST') return createShare(h.state.storage.sql, (await request.json()) as CreateShareInput);
  const shareDeleteMatch = path.match(/^\/shares\/([a-zA-Z0-9_-]+)$/);
  if (shareDeleteMatch && request.method === 'DELETE') return revokeShare(h.state.storage.sql, shareDeleteMatch[1]!);

  return json({ error: 'not_found' }, 404);
}
