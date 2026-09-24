import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, seedApp, seedUser, session, mockNetwork, resetTables } from './helpers';

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => { mockNetwork(); await resetTables(); });

/**
 * #148 end to end inside workerd: the verify tool registers through the real
 * route into real D1, and calling it runs the platform's chess.js in THIS
 * worker between the two data-worker hops (both intercepted here).
 */
describe('verify actions in the Workers runtime', () => {
  const claim = {
    name: 'claim_game_over',
    description: 'Replay the stored moves and record the result only if the game is really over',
    operation: 'verify',
    verifier: 'chess.replay',
    sql: 'SELECT moves FROM games WHERE id = :game_id AND (white_id = :__user_id OR black_id = :__user_id)',
    statements: [
      "UPDATE games SET status = 'finished', result = :__verify_result, end_reason = :__verify_reason, finished_at = :__now WHERE id = :game_id AND (white_id = :__user_id OR black_id = :__user_id) AND :__verify_over = 1",
    ],
    params: { game_id: { type: 'string' } },
    requires_auth: true,
  };

  it('registers, then verifies a checkmate and writes the server-derived verdict', async () => {
    await seedUser('gh:1', 'alice');
    await seedApp('chess', 'gh:1');
    const tok = await session('gh:1');
    const dw = fetchMock.get(`https://pas-data-chess.${env.DATA_WORKER_HOST}`);
    dw.intercept({ path: '/validate', method: 'POST' }).reply(200, { results: [{ id: 'claim_game_over#0', ok: true }, { id: 'claim_game_over#1', ok: true }] });
    const reg = await SELF.fetch(`${BASE}/v1/apps/chess/tools`, json('PUT', { tools: [claim] }, tok));
    expect(reg.status).toBe(200);
    const stored = await env.DB.prepare("SELECT manifest FROM app_tools WHERE app_id = 'chess' AND name = 'claim_game_over'").first<{ manifest: string }>();
    expect(JSON.parse(stored!.manifest)).toMatchObject({ operation: 'verify', verifier: 'chess.replay' });

    let written: { statements: { sql: string; params: unknown[] }[] } | null = null;
    dw.intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [{ moves: '["e4","e5","Bc4","Nc6","Qh5","Nf6","Qxf7#"]' }], meta: {} });
    dw.intercept({ path: '/batch', method: 'POST' }).reply(200, (req) => {
      written = JSON.parse(String(req.body)) as typeof written;
      return { results: [{ rows: [], meta: { changes: 1, last_row_id: 0 } }] };
    });
    const res = await SELF.fetch(`${BASE}/v1/apps/chess/actions/claim_game_over`, json('POST', { params: { game_id: 'g1' } }, tok));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      verifier: 'chess.replay',
      output: { legal: true, over: true, result: '1-0', reason: 'checkmate', ply: 7, turn: 'b', in_check: true },
      writes: [{ changes: 1, last_row_id: 0 }],
    });
    expect(written!.statements[0]!.params).toEqual(['1-0', 'checkmate', expect.any(Number), 'g1', 'gh:1', 'gh:1', true]);
  });
});
