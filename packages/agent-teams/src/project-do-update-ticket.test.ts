import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { ProjectDO } from './project-do.ts';

// Loaded through `createRequire` rather than imported: Vite's resolver drops the
// `node:` prefix on this one and then cannot find a bare "sqlite". Requiring it
// at runtime keeps the workaround inside this file instead of adding an
// externalisation rule to the shared vitest config for a single test.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * `PATCH /tickets/:id` against an unknown id (#137).
 *
 * The RESPONSE was already right — `updateTicket` ends by calling `getTicket`,
 * which 404s on a miss. What was wrong is what happened on the way there: an
 * UPDATE that matched no rows, then `broadcast({type:'ticket-updated'})`, so
 * every open board and panel handled a change to a card it could not find. A
 * broadcast cannot be taken back once sent, and `sql.exec` exposes no
 * changed-row count to test after the fact, so the guard has to be a pre-check.
 *
 * This is the first test in this package to drive the DO itself. The stub below
 * is deliberately tiny: `ProjectDO`'s constructor only assigns its two
 * arguments, its gates are header checks, and everything else it needs here is
 * `storage.sql.exec` and `getWebSockets`.
 */

/** Enough `DurableObjectState` to run the ticket routes, over real SQLite. */
function fakeState() {
  const db = new DatabaseSync(':memory:');
  const broadcasts: unknown[] = [];
  const socket = {
    send: (data: string) => { broadcasts.push(JSON.parse(data)); },
  };
  const state = {
    storage: {
      sql: {
        exec(sql: string, ...params: unknown[]) {
          if (/^\s*select/i.test(sql)) {
            const stmt = db.prepare(sql);
            const rows = stmt.all(...(params as never[]));
            return { toArray: () => rows };
          }
          // `exec` for the param-less statements, which is where the DDL lives:
          // the schema arrives as ONE multi-statement blob, and `prepare` would
          // silently take only its first statement and create one table.
          if (params.length === 0) db.exec(sql);
          else db.prepare(sql).run(...(params as never[]));
          return { toArray: () => [] };
        },
      },
    },
    getWebSockets: () => [socket],
  };
  return { state, broadcasts, db };
}

const OWNER = 'user-1';
const TICKET = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function setup() {
  const { state, broadcasts, db } = fakeState();
  const doInstance = new ProjectDO(state as never, {} as never);

  // Drive one harmless request so the DO runs `ensureSchema` and creates its
  // tables through its own code path rather than a copy of the schema here.
  await doInstance.fetch(new Request('http://do/tickets', { headers: { 'X-User-Id': OWNER } }));

  db.exec(
    `INSERT INTO project (id, owner_id, name, slug, created_at)
     VALUES ('p1', '${OWNER}', 'Probe', 'probe', 1)`,
  );
  db.exec(
    `INSERT INTO tickets (id, seq, title, raw_idea, status, created_at, updated_at)
     VALUES ('${TICKET}', 1, 'Original title', 'Original idea', 'inbox', 1, 1)`,
  );
  broadcasts.length = 0;
  return { doInstance, broadcasts, db };
}

const patch = (doInstance: ProjectDO, id: string, body: unknown) =>
  doInstance.fetch(
    new Request(`http://do/tickets/${id}`, {
      method: 'PATCH',
      headers: { 'X-User-Id': OWNER, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('PATCH /tickets/:id on an unknown ticket (#137)', () => {
  it('404s and broadcasts NOTHING', async () => {
    const { doInstance, broadcasts } = await setup();

    const res = await patch(doInstance, 'ffffffff-0000-0000-0000-000000000000', { title: 'Ghost' });

    expect(res.status).toBe(404);
    // The regression: a `ticket-updated` here reaches every open board for a
    // card that does not exist.
    expect(broadcasts).toEqual([]);
  });

  it('still updates and broadcasts for a ticket that DOES exist', async () => {
    const { doInstance, broadcasts, db } = await setup();

    const res = await patch(doInstance, TICKET, { title: 'Corrected title' });

    expect(res.status).toBe(200);
    expect(broadcasts).toContainEqual({ type: 'ticket-updated', ticketId: TICKET });

    const row = db.prepare('SELECT title, raw_idea FROM tickets WHERE id = ?').get(TICKET) as {
      title: string;
      raw_idea: string;
    };
    expect(row.title).toBe('Corrected title');
    // The merge: a field nobody mentioned survives.
    expect(row.raw_idea).toBe('Original idea');
  });

  it('leaves the stored row untouched when the id is unknown', async () => {
    const { doInstance, db } = await setup();

    await patch(doInstance, 'ffffffff-0000-0000-0000-000000000000', { title: 'Ghost' });

    const row = db.prepare('SELECT title FROM tickets WHERE id = ?').get(TICKET) as { title: string };
    expect(row.title).toBe('Original title');
  });
});
