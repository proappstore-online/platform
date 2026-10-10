import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { MCP_BROKER_VERSION } from './mcp-broker.js';

describe('remote MCP broker (#355)', () => {
  const requestId = 'req_abcdefghijklmnopqrstuvwxyz012345';
  const secretPayload = JSON.stringify({
    request_id: requestId,
    machine_proof: 'machine-proof-must-never-be-echoed',
    code_verifier: 'pkce-verifier-must-never-be-echoed',
    session: 'pas-session-must-never-be-echoed',
  });

  it.each([
    ['POST', '/v1/mcp/broker/v1/requests'],
    ['GET', `/v1/mcp/broker/v1/requests/${requestId}`],
    ['POST', `/v1/mcp/broker/v1/requests/${requestId}/approve`],
    ['POST', `/v1/mcp/broker/v1/requests/${requestId}/deny`],
    ['POST', `/v1/mcp/broker/v1/requests/${requestId}/cancel`],
    ['POST', '/v1/mcp/broker/v1/requests/poll'],
    ['POST', '/v1/mcp/broker/v1/requests/redeem'],
    ['POST', '/v1/mcp/broker/v1/requests/connected'],
    ['POST', '/v1/mcp/broker/v1/requests/failed'],
    ['GET', `/v1/mcp/broker/v1/requests/${requestId}/status`],
  ])('%s %s fails closed without parsing or reflecting credentials', async (method, path) => {
    const response = await app.request(path, {
      method,
      headers: {
        Authorization: 'Bearer pas-bearer-must-never-be-echoed',
        'Content-Type': 'application/json',
      },
      body: method === 'POST' ? secretPayload : undefined,
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const body = await response.text();
    expect(body).toContain('remote_auth_unavailable');
    expect(body).toContain(MCP_BROKER_VERSION);
    for (const secret of ['machine-proof-must-never-be-echoed', 'pkce-verifier-must-never-be-echoed', 'pas-session-must-never-be-echoed']) {
      expect(body).not.toContain(secret);
    }
  });
});
