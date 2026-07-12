# Phase 4 — Loop Prevention (no echo)

Bidirectional sync — two paired one-way `SyncRule`s — creates a real ping-pong risk: A changes → synced to B →
B's own poll detects it → synced back to A → forever. This file owns the **no-echo** invariant: the
authoritative durable check against per-side `SyncFieldState` baselines, the recently-written cache fast path,
**canonical-form capture** (so target normalization doesn't defeat the check), and the `RecordLink`-state
handling of create and delete echoes. "No echo" is a hard invariant, not a heuristic.

Every criterion is deterministic and unit-testable with fake `SyncFieldState`/`RecordLink` stores and a fake
clock (for the cache TTL); the correctness path never depends on the cache.

**Actor:** system (Sync Engine — Loop Prevention stage).

**Concept references (whole file):** [sync-engine.md](../architecture/sync-engine.md) *Loop prevention* (the
whole section — authoritative check, fast path, canonical-form capture, create/delete echoes), *Change
detection* (why Identity Resolution precedes Loop Prevention), *Change types* (tombstones);
[sync-polling-pull.md](../flows/sync-polling-pull.md) step 3.2; [data-model.md](../architecture/data-model.md)
`SyncFieldState` (`lastSyncedHash` canonical per side), `RecordLink` (tombstones);
[observability.md](../architecture/observability.md) *Metrics* (skipped-loop rate); [glossary.md](../glossary.md)
`Loop Prevention`, `SyncFieldState`, `Tombstone`.

> **Correctness never depends on the cache TTL or on the target supporting write tags.** Both are optimizations;
> the durable per-side baseline is authoritative. Any implementation must keep echo detection working when the
> cache is cold and the target supports no metadata.

---

## EP-1 — Authoritative echo check against per-side reconciled baselines (no TTL)

**As an** operator, **I** rely on an incoming change being compared field-by-field against **its own side's**
reconciled baselines, **so that** the echo of the mediator's own write is recognized and dropped no matter how
long after the write the echoing poll runs.

### Acceptance criteria

1. **Given** an incoming change from side X (after its `RecordLink` is resolved), **when** Loop Prevention runs,
   **then** it compares the change **field-by-field** against **side X's own** reconciled baselines — the
   per-side-field `SyncFieldState` rows for side X, each in side X's canonical representation
   ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention*; [sync-polling-pull.md](../flows/sync-polling-pull.md)
   step 3.2).
2. **Given** the comparison, **when** it selects fields, **then** it covers **every** side-X field participating
   in *either* direction's mapping — as a transform's primary input, an additional `aggregate`/`expression`
   input, or an output — keeping it well-defined even when the two directions pair fields asymmetrically or a
   transform takes several inputs ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention*).
3. **Given** **every** such field matches its row's `lastSyncedHash`, **when** the check concludes, **then** the
   change carries nothing new — it is the echo of the mediator's own write (or a no-op) — and is recorded
   `SyncEvent.status = skipped-loop` and processing **stops**
   ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention*).
4. **Given** an echo always arrives on the side that was **last written**, **when** the comparison runs, **then**
   it is always **same-representation** — never across a transform — because the baseline is in that same side's
   canonical form ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention*).
5. **Given** the baselines are **durable**, **when** the written side's next poll runs **hours** after the
   mediator's write, **then** the echo is still recognized — echo detection does **not** depend on any cache
   lifetime ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention*).
6. **Given** Loop Prevention needs the record's `RecordLink` (`SyncFieldState` is keyed by it), **when** it runs,
   **then** it runs **after** Identity Resolution — only the cache fast path (EP-2) may short-circuit before it
   ([sync-engine.md](../architecture/sync-engine.md) *Change detection*).

### Out of scope

- The conflict check (a genuine, non-echo change that drifted) — CF-1; Loop Prevention only drops echoes.
- Seeding the baselines — BE-4/BE-5; updating them on a write — OC-5.

### Dependencies

Blocked by SD-3, RL-1, OC-5. Precedes CF-1.

---

## EP-2 — Recently-written cache fast path (optimization only)

**As the** Sync Engine, **I** short-circuit the obvious echo via a short-TTL "recently written by mediator"
cache before field-level comparison, **so that** the common case is cheap — without correctness ever depending
on the cache.

### Acceptance criteria

1. **Given** a mediator write, **when** it commits, **then** a short-TTL cache entry per
   `(appId, resource, native id)` marks the target's resource as recently written (OC-5)
   ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention* — fast path).
2. **Given** an incoming change that hits a live cache entry, **when** Loop Prevention runs, **then** it may
   **short-circuit** ahead of the field-level comparison and even ahead of Identity Resolution (the only fast
   path allowed to precede it), recording `skipped-loop`
   ([sync-engine.md](../architecture/sync-engine.md) *Change detection*, *Loop prevention*).
3. **Given** mediator-originated writes, **when** the target API supports write metadata, **then** they are
   **additionally** tagged via a passthrough header/field — a second optimization
   ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention*).
4. **Given** the cache is **cold** (TTL expired) or the target supports **no** tags, **when** an echo arrives,
   **then** it is **still** caught by the authoritative durable check (EP-1) — correctness never depends on the
   cache TTL or on tag support ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention*).
5. **Given** the fast path is tested, **when** correctness is asserted, **then** a unit test proves that with the
   cache disabled the echo is **still** recognized by EP-1 — the cache is an accelerator, not the guarantee.

### Out of scope

- Cache invalidation on rule/state changes beyond TTL expiry — an implementation concern; the durable check is
  the correctness backstop regardless.

### Dependencies

Blocked by EP-1, OC-5. Precedes CF-1.

---

## EP-3 — Canonical-form capture: baseline from the target's stored representation

**As an** operator, **I** rely on the written side's baseline being recorded from what the target **stored**,
not what the mediator **sent**, **so that** server-side normalization (trimming, date reformatting, defaults)
doesn't defeat echo detection and cause ping-pong over formatting.

### Acceptance criteria

1. **Given** a mediator write, **when** the written side's `SyncFieldState.lastSyncedHash` is captured, **then**
   it is taken from the target's **stored representation** — the write **response body** when the API returns the
   updated resource (the common REST case), or a **follow-up read** of the written record when it doesn't
   ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention* — canonical-form capture; OC-5).
2. **Given** the same write, **when** the **source** side's baseline is captured, **then** it is the **observed
   source value** the write was computed from ([sync-engine.md](../architecture/sync-engine.md) *Loop
   prevention*).
3. **Given** the target normalized the value (e.g. trimmed a string or reformatted a date), **when** the target's
   echoing poll returns the normalized value, **then** it **matches** the canonically-captured baseline exactly
   and is dropped `skipped-loop` — rather than looking like a new change and ping-ponging
   ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention*).
4. **Given** each side's baseline lives in **its own** canonical representation, **when** a transformed pair is
   baselined, **then** the two sides hold two representations of one reconciled fact (e.g. `"DE"` on one side,
   `"Germany"` on the other) and comparisons never cross the transform boundary
   ([data-model.md](../architecture/data-model.md) `SyncFieldState`).

### Out of scope

- The transform that produced the sent value — TX; this story is about capturing the *stored* result.

### Dependencies

Blocked by EP-1, OC-5, SD-3. Precedes CF-1.

---

## EP-4 — Create and delete echoes via `RecordLink` state

**As an** operator, **I** rely on create and delete echoes — which have no comparable content — being recognized
via `RecordLink` state, **so that** the mediator's own create/delete coming back is dropped and a deleted record
is never resurrected.

### Acceptance criteria

1. **Given** the mediator created a record in the target (RL-2), **when** the target's subsequent "new record"
   poll hit arrives, **then** the `RecordLink` written at propagation time (carrying the target's new native id)
   identifies it as the mediator's **own create** — an echo — rather than a genuine new record
   ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention* — create echoes).
2. **Given** the mediator propagated a deletion and tombstoned the link `propagated-delete`, **when** the other
   side's delete echo is observed, **then** it is recognized as the mediator's own deletion coming back and
   recorded `skipped-loop` ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention* — delete echoes).
3. **Given** a link tombstoned `observed-delete` (a severed pair, no propagation), **when** a change on the
   surviving side arrives, **then** **no** echo is expected — it is recorded `skipped-policy` (counterpart
   deleted), distinct from a `skipped-loop` echo ([sync-engine.md](../architecture/sync-engine.md) *Loop
   prevention*, *Change types*).
4. **Given** either tombstone kind, **when** a slower poll cycle still shows the record in an old snapshot diff,
   **then** the tombstone **prevents resurrection** — the record is not re-created
   ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention*).
5. **Given** loop-prevention outcomes, **when** they are counted, **then** the `skipped-loop` rate is emitted as
   a metric ([observability.md](../architecture/observability.md) *Metrics*).

### Out of scope

- Deciding whether to *propagate* a delete or park it on drift — CF-7 / SP-3.
- Establishing / tombstoning the link — RL-2 / RL-5.

### Dependencies

Blocked by EP-1, RL-2, RL-5. Precedes CF-7.
