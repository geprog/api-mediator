# Phase 4 — Per-`RecordLink` ordering queue

The **consistency backbone**: a durable, single-active-worker-per-key queue that serializes every pipeline
execution for a linked record — **across both directions of a pair** — so the two directions can never race on
their shared `SyncFieldState`/`RecordLink` state. This file owns the queue table (`SKIP LOCKED`
single-active-worker-per-key), the decision to **key by `RecordLink`** (not per `(mapping, resourceId)`), the
**pre-link identity-value keying** with its native-id fallback, and the **continuation handoff** that keeps one
record on one queue at the moment a link is established. It is the home of the cross-direction ordering race —
one of the sharpest risk-register items.

Every criterion is deterministic and unit-testable with an in-memory/real queue and a fake pipeline; the swap-
race prevention is asserted by driving two directions concurrently and proving serialization.

**Actor:** system (Sync Engine — queue dispatcher + workers).

**Concept references (whole file):** [sync-engine.md](../architecture/sync-engine.md) *Ordering and consistency*
(the whole section — keying by `RecordLink`, the swap failure, pre-link identity keying, the continuation
handoff, the enqueue-then-advance interaction); [sync-polling-pull.md](../flows/sync-polling-pull.md) step 3;
[data-model.md](../architecture/data-model.md) `RecordLink` (`establishedBy` retains the pre-link key),
`SyncFieldState`; [glossary.md](../glossary.md) `RecordLink`, `SyncFieldState`.

> **The keying rules and the continuation handoff are authoritative; the queue's storage/locking mechanism is
> the implementation choice.** The plan names a `SKIP LOCKED` single-active-worker-per-key table; any mechanism
> that guarantees at-most-one active worker per key and durable entries is acceptable.

---

## OQ-1 — Durable single-active-worker-per-key queue (`SKIP LOCKED`)

**As the** Sync Engine, **I** process each key's changes on a sequential queue with at most one active worker
per key while other keys proceed in parallel, **so that** per-record ordering is guaranteed without serializing
the whole engine.

### Acceptance criteria

1. **Given** the queue, **when** workers pull work, **then** **at most one** worker is active per key at any
   moment (the `SKIP LOCKED` single-active-worker-per-key discipline), while entries under **different** keys
   are processed **in parallel** ([sync-engine.md](../architecture/sync-engine.md) *Ordering and consistency*).
2. **Given** entries under one key, **when** they are processed, **then** they run **sequentially** in enqueue
   order — a record's later change never overtakes its earlier one on the same key.
3. **Given** queue entries, **when** they are enqueued, **then** they are **durable** — an entry survives a crash
   and is re-picked-up on restart, which is what makes SP-5's enqueue-then-advance safe
   ([sync-engine.md](../architecture/sync-engine.md) *Ordering and consistency*).
4. **Given** different records, different resources, or unrelated mappings, **when** they are processed, **then**
   their **cross-record / cross-mapping ordering is not guaranteed and not required** — only same-key ordering is
   ([sync-engine.md](../architecture/sync-engine.md) *Ordering and consistency*).
5. **Given** a permanently failing record parked at the retry ceiling (OC-4), **when** it is parked, **then** the
   queue **moves on** — a park does not hold its key's worker or block other keys
   ([sync-engine.md](../architecture/sync-engine.md) *Write failures*).

### Out of scope

- What the key *is* — OQ-2/OQ-3 (this story is the queue mechanics; keying is separate).
- The pipeline that runs on each entry — RL/EP/CF/TX/OC.

### Dependencies

Blocked by SD-2. Precedes OQ-2, OQ-3, OQ-4, SP-5.

---

## OQ-2 — Key by `RecordLink`, preventing the cross-direction swap

**As an** operator, **I** rely on both directions of a pair serializing on **one** queue keyed by the shared
`RecordLink`, **so that** two concurrent directional writes can never swap the two sides' values permanently.

### Acceptance criteria

1. **Given** a linked record, **when** its queue key is chosen, **then** it is keyed by the record's
   **`RecordLink`** — deliberately **not** by `(mapping, resourceId)` — so both directions of a bidirectional
   pair (two mappings) run on the **same** queue ([sync-engine.md](../architecture/sync-engine.md) *Ordering and
   consistency*).
2. **Given** both sides of a linked record change within the same poll window and the two directions' pipelines
   would otherwise run concurrently, **when** they are serialized on the one link-keyed queue, **then** whichever
   direction runs **second** sees the first's updated `SyncFieldState` and **correctly surfaces the conflict** —
   the two sides' values are **never** swapped ([sync-engine.md](../architecture/sync-engine.md) *Ordering and
   consistency*).
3. **Given** the failure this keying prevents, **when** it is tested, **then** an explicit unit test drives both
   directions concurrently and asserts they **do not** both pass their conflict check and both write (the silent,
   permanent value-swap the concept calls out) — serialization forces the second to see drift
   ([sync-engine.md](../architecture/sync-engine.md) *Ordering and consistency*).
4. **Given** `SyncFieldState` and `RecordLink` are **shared** across a counterpart pair, **when** either
   direction reads/writes them, **then** it does so under the one-queue serialization — never two queues over the
   same shared state ([data-model.md](../architecture/data-model.md) `SyncFieldState`, `RecordLink`).

### Out of scope

- The pre-link case (no link yet) — OQ-3.
- The conflict check logic itself — CF-1.

### Dependencies

Blocked by OQ-1, SD-2, SD-3. Precedes OQ-4, CF-1.

---

## OQ-3 — Pre-link identity-value keying (and native-id fallback), resolved at enqueue

**As the** Sync Engine, **I** key an unlinked record's changes by its shared identity value (or its native id
when there is neither link nor identity value), resolved cheaply before enqueue, **so that** two directions
concurrently establishing "the same" record serialize instead of racing into duplicates.

### Acceptance criteria

1. **Given** a change for a record with **no** link yet, **when** its queue key is chosen, **then** it falls back
   to the record's **identity-key value** — guaranteed the **same** value from either side because the identity
   pairing is shared and value-preserving (`rename`-only) — so two directions concurrently matching-then-creating
   "the same" record serialize on one queue ([sync-engine.md](../architecture/sync-engine.md) *Ordering and
   consistency*, *Identity correlation*).
2. **Given** a change carrying **neither** a link **nor** an identity value (e.g. a full-fetch delete of a
   never-linked record), **when** its key is chosen, **then** it keys by its **own native id** — it touches no
   shared pair state, so serializing it alone is sufficient
   ([sync-engine.md](../architecture/sync-engine.md) *Ordering and consistency*).
3. **Given** Identity Resolution runs **inside** the queued execution (not before enqueue), **when** the key is
   needed at enqueue, **then** the dispatcher resolves it with a **cheap pre-enqueue lookup**: an active
   `RecordLink` by (app, native id) → the link id; otherwise the record's identity-key value as fetched;
   otherwise its native id ([sync-engine.md](../architecture/sync-engine.md) *Ordering and consistency*).
4. **Given** the fallback assumes the identity value is **stable** while the record is unlinked (the normal case
   for business keys), **when** a pre-link change **itself rewrites the identity field**, **then** the change may
   briefly queue under old and new value — narrowing the guarantee for exactly that record back to
   match-first-before-create — and this narrowing is documented, not silently ignored
   ([sync-engine.md](../architecture/sync-engine.md) *Ordering and consistency*).

### Out of scope

- The transition from the pre-link key to the link key — OQ-4 (the continuation handoff).
- Fetching the identity value (part of Identity Resolution) — RL-3.

### Dependencies

Blocked by OQ-1, RL-1. Precedes OQ-4, SP-5.

---

## OQ-4 — Continuation handoff: the link-keyed queue opens only after the establishing queue drains

**As an** operator, **I** rely on the link-keyed queue opening strictly as a **continuation** of the pre-link
queue that created the link — never beside it — **so that** a record is on exactly one queue at every moment of
the handoff, even as one direction still runs under the identity value.

### Acceptance criteria

1. **Given** a link is established (create-propagation or identity-match), **when** it is written, **then** it
   **records the pre-link queue key** it was established under (SD-2, RL-2)
   ([data-model.md](../architecture/data-model.md) `RecordLink.establishedBy`;
   [sync-engine.md](../architecture/sync-engine.md) *Ordering and consistency*).
2. **Given** one direction is still queued under the identity value while another — seeing the link that
   execution just created — would enqueue under the **link id**, **when** the handoff occurs, **then** the
   link-keyed queue **opens only as a continuation**: it **starts after** the establishing (pre-link) queue
   drains, **never beside it** ([sync-engine.md](../architecture/sync-engine.md) *Ordering and consistency*).
3. **Given** the handoff, **when** it is in progress, **then** the invariant **one record, one queue, at every
   moment** holds — there is never a window where the same record is actively processed on both the identity-value
   queue and the link queue ([sync-engine.md](../architecture/sync-engine.md) *Ordering and consistency*).
4. **Given** a **manual** link (no establishing execution), **when** it is created, **then** it records the pair's
   identity-key value as the pre-link key, or — absent a confirmed identity key — the link-keyed queue opens only
   after **both** sides' native-id-keyed queues drain (RL-5)
   ([data-model.md](../architecture/data-model.md) `RecordLink.establishedBy`).
5. **Given** the handoff is a hard invariant, **when** it is tested, **then** a unit test proves that a change
   enqueued under the link id does not begin processing until the establishing pre-link queue has drained —
   asserting the continuation, not a parallel second queue.

### Out of scope

- The enqueue-then-advance cursor interaction — SP-5 (queue durability is OQ-1; SP-5 requires enqueue precede
  advance).

### Dependencies

Blocked by OQ-2, OQ-3, RL-2, RL-5. Precedes CF-1.
