import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from './auth.js';
import type { Env } from '../types.js';

/**
 * Wrap a route handler so a thrown HttpError becomes a plain-text response with
 * its status; anything else propagates to the app's error handler.
 *
 * Do not use this for a route which deliberately changes an error contract.
 * The remaining inline HttpError catches are intentional: payment routes map
 * provider failures to 502; invite/storage paths continue after or decorate a
 * refusal; AI and secret routes return JSON envelopes; analytics/passkey/QA
 * paths translate upstream validation; deploy returns JSON for its admin API;
 * and the app-worker deploy route must audit both refusals and failures. Their
 * status, body shape, headers and audit effects are public behaviour, not
 * duplication. See #314.
 */
export function wrap(handler: (c: Context<{ Bindings: Env }>) => Promise<Response>) {
  return async (c: Context<{ Bindings: Env }>) => {
    try {
      return await handler(c);
    } catch (err) {
      if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
      throw err;
    }
  };
}
