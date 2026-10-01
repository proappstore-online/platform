import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from './auth.js';
import type { Env } from '../types.js';

/**
 * Wrap a route handler so a thrown HttpError becomes a plain-text response with
 * its status; anything else propagates to the app's error handler.
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
