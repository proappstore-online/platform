# ADR-010: Room authorization and app-worker publishing

## Status

Accepted

## Date

2026-10-09

## Context

Rooms (Durable-Object WebSocket fan-out) admitted every signed-in caller the
app's visibility gate allowed, to **any** room id: there was no per-room
access control. That was enough for cursors and lobbies. It was not enough for
#351: DoorDrop must replace its polling of chat, doors, notifications and
tracking with events its app worker publishes, and those events belong to one
user (`notifications:{userId}`) or one campaign (`chat:{campaignId}`). A
server-side publish into rooms anyone can join would broadcast one user's or
one tenant's events to every signed-in caller who guessed the room id.

So publishing needs two things: a worker-only path into a room, and rooms
whose membership the platform enforces.

## Decision

1. **Three kinds of room, decided from the room id** (`lib/room-access.ts`):
   - `user:<uid>` is reserved by the platform: only the signed-in user `<uid>`
     may join it.
   - A room whose id starts with a prefix the app declares in `mcp.json`
     `rooms` (`[{ "pattern": "chat:*", "authorize": "can_join_chat" }]`) admits
     a user only when the registered **query** action `authorize`, run as that
     user (their role gates, `:__user_id` bound to them), returns a row. It
     receives `room` (the full id) and `key` (the part after the prefix). The
     app owns the membership model; the platform only enforces its answer.
   - Every other room stays open to every caller the app's visibility admits,
     as before, so existing apps keep working unchanged.
2. **Enforced at the join and on open sockets.** The upgrade route refuses with
   close `4401 room_forbidden` (not retried by the SDK). The room's existing
   60-second re-check alarm (#276) re-runs the same rule on every open socket,
   so a revoked membership closes within a minute. A data-worker outage while
   authorizing is never a refusal: the join answers 503 (retried) and the
   re-check keeps the socket.
3. **Publishing is the app worker's, and only into its own app.**
   `PAS.rooms.publish(roomId, data)` (`AppWorkerApi`) takes the app from the
   binding's platform-set props and authorizes the call like every PAS call
   (token, running invocation, budget). It reaches the Room Durable Object
   through its binding on an internal POST path the WebSocket route never
   forwards, so no browser can send a server event, and the frame
   `{ kind: 'event', from: { uid: 'system:worker' }, data, at, seq }` is
   distinguishable from a peer's `{ kind: 'msg' }`. It always publishes as
   `system:worker`, also inside a caller grant's request.
4. **Bounded:** `data` is JSON of at most 4 KB serialized (the peer message
   cap); 60 publishes a minute per app (an atomic one-minute window in D1,
   beside the per-invocation PAS budget, which a publish also counts toward).
5. **No delivery guarantee; refetch on reconnect.** Events are not persisted or
   replayed. The publish answers `{ delivered }` (0 when nobody is connected,
   not an error); `seq` grows by one per event in the room so a client can see a
   gap; the browser SDK's `room.onReconnect()` fires after every restored
   connection. Clients keep their data in actions and treat events as "refetch
   now" hints, with polling only as a disconnected fallback.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Restrict only publishing, leave joins open | Anyone could join `notifications:<someone>` and read what the worker publishes there: fails "no arbitrary user-room" and cross-tenant isolation. |
| Platform-defined tenant rooms | The platform has no tenant model; apps do (`TenantScope`, their own tables). An app-declared authorize action reuses the action authorization every app already uses. |
| Persist events and replay on reconnect | Duplicates the app's own data store and needs storage, ordering and retention. Refetching the source of truth after a reconnect is simpler and always correct. |
| Publish via the client `send` path with a server token | Server events would be indistinguishable from peer messages and forgeable by any peer. |

## Consequences

**Positive:**
- An app worker can push to connected clients, so apps replace polling with events.
- Room membership is enforced by the platform, from a rule the app declares.
- Existing rooms and the existing browser API are unchanged; `onEvent` and `onReconnect` are additive.

**Negative:**
- A declared room's authorize action runs on every join and once a minute per connected user, through the data worker.
- A room id under a declared prefix that the app forgets to authorize correctly refuses everyone (fail closed).

**Neutral:**
- Events are hints, not a log: a client that was disconnected must refetch.
