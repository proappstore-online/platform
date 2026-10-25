import { describe, expect, it } from 'vitest';
import { MAX_DEPLOY_ATTEMPTS } from './deploy-stage.ts';
import {
  advanceOnce, autoAdvance, blockForInput, clearWatchdog, failTicket, reconcileStuck, runWatchdogAlarm, scheduleWatchdog, setPlayState,
} from './project-pipeline.ts';
import { fakeHost, seedProject, seedTicket } from './project-test-host.ts';

const statusOf = (db: ReturnType<typeof fakeHost>['db'], id: string) => (db.prepare('SELECT status FROM tickets WHERE id = ?').get(id) as { status: string }).status;
const projectStatus = (db: ReturnType<typeof fakeHost>['db']) => (db.prepare('SELECT status FROM project').get() as { status: string }).status;

describe('watchdog', () => {
  it('arms and clears the alarm', () => {
    const { host, alarm } = fakeHost();
    const before = Date.now();
    scheduleWatchdog(host);
    expect(alarm.at).toBeGreaterThanOrEqual(before + 60_000);
    clearWatchdog(host);
    expect(alarm.at).toBeNull();
  });

  it('does nothing, and does not re-arm, for a paused project', () => {
    const { host, db, alarm } = fakeHost();
    seedProject(db);
    seedTicket(db, 't1', 'inbox');
    runWatchdogAlarm(host);
    expect(statusOf(db, 't1')).toBe('inbox');
    expect(alarm.at).toBeNull();
  });

  it('does nothing before the project exists', () => {
    const { host, alarm } = fakeHost();
    runWatchdogAlarm(host);
    expect(alarm.at).toBeNull();
  });

  it('re-arms while the project is still running', () => {
    const { host, db, alarm } = fakeHost();
    seedProject(db, { status: 'running' });
    runWatchdogAlarm(host);
    expect(projectStatus(db)).toBe('running');
    expect(alarm.at).not.toBeNull();
  });
});

describe('setPlayState', () => {
  it('pausing records the state, broadcasts it and clears the watchdog', async () => {
    const { host, db, broadcasts, activity, alarm } = fakeHost();
    seedProject(db, { status: 'running' });
    alarm.at = 123;
    const res = setPlayState(host, 'paused');
    expect(await res.json()).toEqual({ status: 'paused' });
    expect(projectStatus(db)).toBe('paused');
    expect(alarm.at).toBeNull();
    expect(broadcasts).toContainEqual({ type: 'play-state', status: 'paused' });
    expect(activity).toContainEqual({ type: 'control', detail: 'Agents paused', ticketId: null });
  });

  it('playing with nothing to do tells the founder in chat and arms the watchdog', async () => {
    const { host, db, broadcasts, alarm } = fakeHost();
    seedProject(db);
    expect(await setPlayState(host, 'running').json()).toEqual({ status: 'running' });
    expect(projectStatus(db)).toBe('running');
    expect(alarm.at).not.toBeNull();
    expect(broadcasts.some((b) => b.type === 'chat' && b.role === 'po' && String(b.body).includes('no work yet'))).toBe(true);
  });

  it('playing resumes a deploy-blocked ticket and resets its retry budget', () => {
    const { host, db, broadcasts } = fakeHost();
    seedProject(db);
    seedTicket(db, 't1', 'needs-input', { assignee_role: null, deploy_attempts: 3 });
    // 'deploying' would be dispatched by the autoAdvance that follows; keep the run from starting.
    host.running.add('t1');
    setPlayState(host, 'running');
    expect(statusOf(db, 't1')).toBe('deploying');
    expect(db.prepare('SELECT deploy_attempts AS n FROM tickets').get()).toEqual({ n: 0 });
    expect(broadcasts).toContainEqual({ type: 'transition', ticketId: 't1', from: 'needs-input', to: 'deploying', reason: 'retry-on-play' });
  });
});

describe('advanceOnce', () => {
  it('moves each ticket one step along the pipeline', () => {
    const { host, db, broadcasts } = fakeHost();
    seedProject(db);
    seedTicket(db, 'a', 'inbox');
    seedTicket(db, 'b', 'awaiting-approval');
    seedTicket(db, 'c', 'ready');
    expect(advanceOnce(host, Date.now())).toBe(true);
    expect([statusOf(db, 'a'), statusOf(db, 'b'), statusOf(db, 'c')]).toEqual(['ba-refining', 'ready', 'dev-active']);
    expect(broadcasts.filter((b) => b.type === 'transition').map((b) => `${b.from}>${b.to}`)).toEqual(['inbox>ba-refining', 'awaiting-approval>ready', 'ready>dev-active']);
  });

  it('returns false when nothing can move', () => {
    const { host, db } = fakeHost();
    seedProject(db);
    seedTicket(db, 'a', 'done');
    expect(advanceOnce(host, Date.now())).toBe(false);
  });

  it('holds new work back at three concurrent active tickets', () => {
    const { host, db } = fakeHost();
    seedProject(db);
    for (const [id, s] of [['a1', 'ba-refining'], ['a2', 'dev-active'], ['a3', 'qa-active']] as const) seedTicket(db, id, s);
    seedTicket(db, 'n', 'inbox');
    expect(advanceOnce(host, Date.now())).toBe(false);
    expect(statusOf(db, 'n')).toBe('inbox');
  });

  it('sends a qa-failed ticket back to dev, then fails it at the iteration cap', () => {
    const { host, db } = fakeHost();
    seedProject(db);
    seedTicket(db, 'x', 'qa-failed', { iterations: 4 });
    seedTicket(db, 'y', 'qa-failed', { iterations: 5 });
    advanceOnce(host, Date.now());
    expect(statusOf(db, 'x')).toBe('dev-active');
    expect(db.prepare("SELECT iterations AS n FROM tickets WHERE id = 'x'").get()).toEqual({ n: 5 });
    expect(statusOf(db, 'y')).toBe('failed');
    expect(db.prepare("SELECT stuck_reason AS r FROM tickets WHERE id = 'y'").get()).toEqual({ r: 'Iteration cap reached (5)' });
  });
});

describe('autoAdvance safety rails', () => {
  it('does nothing for a paused project', () => {
    const { host, db } = fakeHost();
    seedProject(db);
    seedTicket(db, 'a', 'inbox');
    autoAdvance(host);
    expect(statusOf(db, 'a')).toBe('inbox');
  });

  it('auto-pauses after 30 idle minutes with nothing running', () => {
    const { host, db, broadcasts, alarm } = fakeHost();
    seedProject(db, { status: 'running', last_user_activity: Date.now() - 31 * 60_000 });
    alarm.at = 1;
    autoAdvance(host);
    expect(projectStatus(db)).toBe('paused');
    expect(alarm.at).toBeNull();
    expect(broadcasts).toContainEqual({ type: 'play-state', status: 'paused', reason: 'idle-timeout' });
  });

  it('does not idle-pause while a run is in flight', () => {
    const { host, db } = fakeHost();
    seedProject(db, { status: 'running', last_user_activity: Date.now() - 31 * 60_000 });
    host.running.add('t1');
    autoAdvance(host);
    expect(projectStatus(db)).toBe('running');
  });

  it('auto-pauses when this month\'s spend reaches the cap, but not on last month\'s', () => {
    const month = new Date().toISOString().slice(0, 7);
    const capped = fakeHost();
    seedProject(capped.db, { status: 'running', cost_spent_monthly_usd: 50, cost_month: month });
    autoAdvance(capped.host);
    expect(projectStatus(capped.db)).toBe('paused');
    expect(capped.broadcasts).toContainEqual({ type: 'play-state', status: 'paused', reason: 'cost-cap' });

    const stale = fakeHost();
    seedProject(stale.db, { status: 'running', cost_spent_monthly_usd: 50, cost_month: '2001-01' });
    autoAdvance(stale.host);
    expect(projectStatus(stale.db)).toBe('running');
  });
});

describe('reconcileStuck (self-heal)', () => {
  const parked = { assignee_role: null, stuck_reason: 'CI red', updated_at: 0 };

  it('re-dispatches a deploy-parked ticket whose backoff has elapsed', () => {
    const { host, db, broadcasts } = fakeHost();
    seedProject(db);
    seedTicket(db, 't1', 'needs-input', { ...parked, deploy_attempts: 1 });
    expect(reconcileStuck(host, Date.now())).toBe(true);
    expect(statusOf(db, 't1')).toBe('deploying');
    expect(broadcasts).toContainEqual({ type: 'transition', ticketId: 't1', from: 'needs-input', to: 'deploying', reason: 'self-heal' });
  });

  it('keeps waiting out the backoff but reports pending work', () => {
    const { host, db } = fakeHost();
    seedProject(db);
    seedTicket(db, 't1', 'needs-input', { ...parked, deploy_attempts: 1, updated_at: Date.now() });
    expect(reconcileStuck(host, Date.now())).toBe(true);
    expect(statusOf(db, 't1')).toBe('needs-input');
  });

  it('leaves a ticket whose retry budget is spent for the human', () => {
    const { host, db } = fakeHost();
    seedProject(db);
    seedTicket(db, 't1', 'needs-input', { ...parked, deploy_attempts: MAX_DEPLOY_ATTEMPTS });
    expect(reconcileStuck(host, Date.now())).toBe(false);
    expect(statusOf(db, 't1')).toBe('needs-input');
  });

  it('ignores an agent that is waiting on the user', () => {
    const { host, db } = fakeHost();
    seedProject(db);
    seedTicket(db, 't1', 'needs-input', { assignee_role: 'BA', stuck_reason: null, deploy_attempts: 0 });
    expect(reconcileStuck(host, Date.now())).toBe(false);
  });
});

describe('blockForInput / failTicket', () => {
  it('parks a ticket for the user with a system chat message', () => {
    const { host, db, broadcasts, activity } = fakeHost();
    seedProject(db);
    seedTicket(db, 't1', 'ba-refining', { assignee_role: 'BA' });
    blockForInput(host, 't1', 'BA', 'Which currency?');
    expect(statusOf(db, 't1')).toBe('needs-input');
    expect(db.prepare('SELECT body FROM chat_history').get()).toEqual({ body: 'Which currency?' });
    expect(activity).toContainEqual({ type: 'blocked', detail: 'Which currency?', ticketId: 't1' });
    expect(broadcasts.map((b) => b.type)).toEqual(['transition', 'chat']);
  });

  it('hard-fails a ticket with the reason', () => {
    const { host, db, broadcasts } = fakeHost();
    seedProject(db);
    seedTicket(db, 't1', 'dev-active');
    failTicket(host, 't1', 'dev-active', 'out of budget');
    expect(statusOf(db, 't1')).toBe('failed');
    expect(db.prepare('SELECT stuck_reason AS r FROM tickets').get()).toEqual({ r: 'out of budget' });
    expect(broadcasts).toContainEqual({ type: 'transition', ticketId: 't1', from: 'dev-active', to: 'failed', trigger: 'system', reason: 'out of budget' });
  });
});
