# Phase 4 — Transformation Executor (+ the `expression` sandbox)

The **Transformation Executor** applies an `ApprovedMapping`'s `FieldMapping`s to convert one app's payload
shape into another's — deterministic, data-in/data-out, shared by the Sync Engine and the Adapter Engine
(Phase 5). This file owns the four transform kinds (`rename` / `coerce` / `aggregate` / `expression`) and the
**sandbox** that makes the LLM-suggested `expression` transform safe. It is pure logic over data already in
memory: no credential access, no network, no persistence — those belong to the Outbound Call Executor (OC).

Every criterion here is deterministic over in-memory inputs, so the executor is exhaustively unit-testable
with hand-written `FieldMapping` fixtures and payloads, no LLM and no running landscape.

**Actor:** system (Sync Engine's pipeline stage; reused by the Adapter Engine in Phase 5).

**Concept references (whole file):** [security.md](../architecture/security.md) *Transformation expression
sandboxing*, *LLM data boundary* ("mapping *execution* — deterministic transforms over real data");
[sync-engine.md](../architecture/sync-engine.md) *Polling pull pipeline* (Transformation Executor stage);
[sync-polling-pull.md](../flows/sync-polling-pull.md) step 3.5; [data-model.md](../architecture/data-model.md)
`FieldMapping` (`transform`/`transformConfig`, `sourcePath` = primary input, `targetPath` = output,
additional inputs in `transformConfig`), *Modeling notes* (no transform ever runs in reverse);
[glossary.md](../glossary.md) `Transformation Executor`, `FieldMapping`.

> **The transform *vocabulary* and the sandbox *constraints* are authoritative; the AST library and evaluator
> internals are the implementation choice.** The plan names jsep + a purpose-built safe evaluator; any
> equivalent that satisfies SD-4's negative-space criteria is acceptable. `transformConfig`'s concrete schema
> per kind is derived here (the concept names the field but not its per-kind shape — see README open question).

---

## TX-1 — Deterministic transform dispatch, `rename`, and `coerce`

**As the** Sync Engine, **I** apply a `FieldMapping`'s declared `transform` in its declared direction to
produce the target field's value, **so that** the same inputs always yield the same output and the target
payload is assembled purely from source data.

### Acceptance criteria

1. **Given** a set of `FieldMapping`s and a source record, **when** the executor runs, **then** it produces
   the target payload shape by applying each `FieldMapping` — reading `sourcePath` (the primary input) and any
   additional input paths from `transformConfig`, writing `targetPath` (the output)
   ([data-model.md](../architecture/data-model.md) `FieldMapping`; [sync-polling-pull.md](../flows/sync-polling-pull.md)
   step 3.5).
2. **Given** a `transform = rename` mapping, **when** applied, **then** the source value is carried to the
   target path **unchanged** (value-preserving; a rename may change the field name but never the value) — the
   same value-preserving property that makes `rename` the only transform an identity key may carry (AS-5)
   ([data-model.md](../architecture/data-model.md) `FieldMapping`; [sync-engine.md](../architecture/sync-engine.md)
   *Identity correlation*).
3. **Given** a `transform = coerce` mapping with a `transformConfig` describing the conversion, **when**
   applied, **then** it performs a deterministic type/representation conversion (e.g. enum `open|closed` →
   boolean, string → number, one date format → another) and yields the target-representation value
   ([data-model.md](../architecture/data-model.md) `FieldMapping.transform`).
4. **Given** the same inputs applied twice, **when** any transform runs, **then** it is **deterministic** —
   identical inputs produce byte-identical output — so echo detection, idempotency keys, and re-processing
   after a crash are stable (a non-deterministic transform would break loop prevention and idempotency).
5. **Given** the executor is shared by both engines, **when** it runs, **then** it applies a transform **only
   in its declared direction** — it never inverts a `FieldMapping` — consistent with the core invariant that
   nothing is ever run in reverse ([data-model.md](../architecture/data-model.md) `ApprovedMapping`,
   *Modeling notes*).

### Out of scope

- Fetching the source record / writing the target — SP and OC.
- `aggregate` and `expression` — TX-2, TX-3.

### Dependencies

Blocked by Phase-3 AM-3 (`FieldMapping` shape). Precedes SP/OC use.

---

## TX-2 — `aggregate` (multi-input → one output)

**As the** Sync Engine, **I** apply an `aggregate` transform that reads several source fields to produce one
target field, **so that** non-1:1 correspondences (e.g. combining parts into one value) are supported without
an expression.

### Acceptance criteria

1. **Given** a `transform = aggregate` mapping, **when** applied, **then** it reads its primary input
   (`sourcePath`) **and** the additional input paths declared in `transformConfig`, combining them per the
   configured aggregation into the single `targetPath` value
   ([data-model.md](../architecture/data-model.md) `FieldMapping` — additional inputs in `transformConfig`).
2. **Given** an `aggregate` mapping, **when** the executor records which fields it touched, **then** **every**
   input (primary and additional) is accounted for, so each gets its own per-side `SyncFieldState` row and echo
   / conflict detection stays well-defined for the multi-input case
   ([data-model.md](../architecture/data-model.md) `SyncFieldState`;
   [sync-engine.md](../architecture/sync-engine.md) *Loop prevention*).
3. **Given** a missing or null additional input, **when** the aggregate runs, **then** it resolves
   deterministically per the configured semantics (e.g. a documented placeholder or a transform error, TX-5) —
   never a non-deterministic or best-effort result.
4. **Given** the same multi-field input applied twice, **when** the aggregate runs, **then** its output is
   deterministic (TX-1 criterion 4 applies to the multi-input case identically).

### Out of scope

- The `expression` form of multi-input (`fullName = firstName + " " + lastName`) — TX-3 (it runs in the
  sandbox; `aggregate` does not).

### Dependencies

Blocked by TX-1. Precedes SP/OC use.

---

## TX-3 — `expression` in a sandboxed, non-Turing-complete evaluator

**As the** Sync Engine, **I** evaluate an `expression` transform in a sandbox that reads inputs and returns a
value with no side effects, **so that** an LLM-suggested expression can transform data without the mediator
ever executing arbitrary host code.

### Acceptance criteria

1. **Given** a `transform = expression` mapping, **when** applied, **then** the executor parses the expression
   to an **AST** (the plan names jsep) and evaluates it with a **purpose-built safe evaluator** over the
   mapping's inputs (primary `sourcePath` + additional paths in `transformConfig`), returning the `targetPath`
   value — data in, data out ([security.md](../architecture/security.md) *Transformation expression
   sandboxing*).
2. **Given** the evaluator, **when** it runs an expression, **then** it exposes only an **allowlist** of
   operators and pure functions (arithmetic/string/comparison/conditional and a fixed set of helper functions)
   — anything not on the allowlist is unavailable, not merely discouraged
   ([security.md](../architecture/security.md) *Transformation expression sandboxing*).
3. **Given** the same expression and inputs, **when** evaluated twice, **then** the result is **deterministic**
   — no wall-clock, randomness, locale, or ambient state leaks into the result (TX-1 criterion 4).
4. **Given** an expression that references an input path not present in the record, **when** evaluated, **then**
   it resolves deterministically (a documented null/placeholder or a transform error per TX-5) — never a host
   exception that escapes the sandbox.
5. **Given** the sandbox is the enforcement boundary and human review is not, **when** an approved expression
   is evaluated, **then** the sandbox constraints (TX-4) apply regardless of who authored it — "review is not
   the security boundary for LLM-suggested code" ([security.md](../architecture/security.md) *Transformation
   expression sandboxing*).

### Out of scope

- The `expression` form on a `ParameterMapping` or a chained `AdapterBinding.chainInputs` — same vocabulary and
  sandbox, but exercised by the Adapter Engine in Phase 5 ([adapter-engine.md](../architecture/adapter-engine.md)).

### Dependencies

Blocked by TX-1. Precedes SP/OC use.

---

## TX-4 — Sandbox negative space: no assignment, loops, recursion, host calls, I/O, or unbounded evaluation

**As an** operator, **I** rely on the `expression` sandbox rejecting anything Turing-complete or
side-effecting, **so that** an approved expression can never read a file, open a socket, mutate host state, or
run unbounded — the sandbox's hard guarantees, tested as explicit failures.

### Acceptance criteria

1. **Given** an expression containing **assignment** (or any statement that mutates state), **when** it is
   parsed/evaluated, **then** it is **rejected** — the sandbox is expression-only, not statement-execution
   ([security.md](../architecture/security.md) *Transformation expression sandboxing*: "no loops or recursion").
2. **Given** an expression that attempts a **loop or recursion** (including via a self-referential helper),
   **when** evaluated, **then** it is **rejected** — the evaluator is non-Turing-complete by construction
   ([security.md](../architecture/security.md)).
3. **Given** an expression that attempts a **host call or I/O** — a network request, filesystem access,
   `require`/`import`, `process`, `globalThis`, prototype/constructor escape, or any non-allowlisted member
   access — **when** evaluated, **then** it is **rejected**: no I/O, no network
   ([security.md](../architecture/security.md)).
4. **Given** an expression exceeding a **bounded node count** at parse time, **when** parsed, **then** it is
   rejected before evaluation; **given** an expression exceeding a **bounded wall-clock** (and bounded memory)
   at evaluation time, **when** run, **then** evaluation is aborted with a transform error — bounded evaluation
   time and memory ([security.md](../architecture/security.md)).
5. **Given** any of the rejections above, **when** they occur, **then** the failure is a **transform error**
   (TX-5) surfaced as such — never a silently-empty value passed downstream to a write.
6. **Given** these constraints, **when** a `rename`/`coerce`/`aggregate` transform runs, **then** it does
   **not** enter the sandbox at all — **only** `expression` is sandbox-evaluated (the other three are fixed,
   auditable operations) ([security.md](../architecture/security.md); plan item 1).

### Out of scope

- Static analysis warnings surfaced at review time — Phase 3 reviewed the expression text; the sandbox is the
  runtime enforcement, and this file specifies the runtime.

### Dependencies

Blocked by TX-3. Precedes SP/OC use.

---

## TX-5 — Transform errors surface, never silently corrupt a write

**As an** operator, **I** have a transform that cannot produce a value fail loudly and stop that field's write,
**so that** a mapping/expression defect is a visible error, never a silently-wrong value written into a real app.

### Acceptance criteria

1. **Given** any transform (rename/coerce/aggregate/expression) that cannot produce a valid output — missing
   required input, an impossible coercion, or a sandbox rejection (TX-4) — **when** it runs, **then** it raises
   a distinct **transform error** rather than returning a fabricated or partial value.
2. **Given** a transform error during a sync write assembly, **when** it occurs, **then** the executor does not
   emit a corrupted payload; the outcome is handled by the calling pipeline as a failure/park (OC-4), and a
   `SyncEvent` records it (SD-4) — never a `success` over bad data.
3. **Given** the Transformation Executor is shared with the Adapter Engine, **when** a transform error occurs
   there (Phase 5), **then** the same distinct error kind is raised — the concept's `mediator-transform-error`
   is that failure surfaced when an aggregated response fails consumer-schema validation
   ([glossary.md](../glossary.md) `mediator-transform-error`); Phase 4 defines the transform-error signal, the
   Adapter Engine wires the response-validation case in Phase 5.
4. **Given** live payload data flows through the executor, **when** a transform runs, **then** **no** payload
   value is ever sent to an LLM — detection (LLM, metadata only) and execution (deterministic transforms over
   real data) stay strictly separated ([security.md](../architecture/security.md) *LLM data boundary*).

### Out of scope

- The retry/dead-letter policy for a failed write — OC-4.
- Consumer-schema response validation and its `mediator-transform-error` return — Phase 5
  ([adapter-engine.md](../architecture/adapter-engine.md)).

### Dependencies

Blocked by TX-1..TX-4. Precedes OC-4.
