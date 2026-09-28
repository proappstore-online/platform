/**
 * The console operator view (#240), mounted as one: its context, resource,
 * record, evidence and action routes, the metric series and the audit trail —
 * with refused requests by a verified owner joining the audit trail.
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { operatorRoutes } from './operator.js';
import { operatorMetricsRoutes } from './operator-metrics.js';
import { operatorAuditRoutes, operatorRefusalAudit } from './operator-audit.js';

export const operatorView = new Hono<{ Bindings: Env }>();
operatorView.use('/apps/:appId/operator/*', operatorRefusalAudit);
operatorView.route('/', operatorRoutes);
operatorView.route('/', operatorMetricsRoutes);
operatorView.route('/', operatorAuditRoutes);
