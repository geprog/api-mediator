# Scenario 5 — business suite (Dolibarr + Kimai + OrangeHRM)

ERP, time tracking and HR — the domain the concept docs' own examples
(customers, invoices, employees, `firstName + lastName`) are written in, and
the classic self-hosted-landscape sync story: employees flow from HR into the
other tools, customers/projects sync between ERP and time tracking, time
entries relate all three without forming a clean 3-way mapping.

| App | Image | Host port | API base | Spec |
|---|---|---|---|---|
| Dolibarr (+MariaDB) | `dolibarr/dolibarr:23.0.3` | 15700 | `/api/index.php` | live (needs `DOLAPIKEY`): `./fetch-dolibarr-spec.sh` |
| Kimai (+MariaDB) | `kimai/kimai2:apache-2.57.0` | 15750 | `/api` | session-gated Stoplight page: `./fetch-kimai-spec.sh` |
| OrangeHRM (+MariaDB) | `orangehrm/orangehrm:5.9` | 15800 | `/web/index.php/api/v2` | generated from container sources: `./fetch-orangehrm-spec.sh` |

## Run

```bash
docker compose up -d --wait   # 6 containers; Dolibarr auto-installs on first boot
./bootstrap.sh                # OrangeHRM headless CLI install, Dolibarr API key,
                              # Kimai API token -> .tokens.env
./seed.sh                     # optional: overlapping business fixtures
../shared/build-specs.sh .    # vendor/refresh all three specs (landscape must run)
```

## How each app was tamed (none of the three is API-friendly out of the box)

- **Dolibarr** installs headlessly via `DOLI_INSTALL_AUTO` + `DOLI_ENABLE_MODULES`;
  the admin API key is set directly on the user row (`bootstrap.sh`). The
  unauthenticated spec endpoint returns a 2-operation stub — the full spec
  needs the `DOLAPIKEY` header.
- **Kimai** creates its superadmin from env, but mints API tokens only in the
  UI — `bootstrap.sh` inserts one into the (plaintext) `kimai2_access_token`
  table. Its production build serves no `/api/doc.json`; the spec is extracted
  from the session-gated Stoplight page. Don't set `TRUSTED_HOSTS` (it makes
  Symfony reject `localhost` as untrusted).
- **OrangeHRM** documents only a web installer, but ships a CLI installer that
  `bootstrap.sh` drives with a generated YAML. It publishes no spec anywhere;
  `./fetch-orangehrm-spec.sh` reproduces the devTools generator inside the
  running container — swagger-php (the version from the app's composer.lock)
  run with the app's own autoloader, without which ~60 operations silently
  drop out (annotation constants fail to resolve). Seeding uses session-cookie
  auth like the web UI; a future mediator needs an OAuth2 client (Admin →
  OAuth in the UI). Beware the one singular route: `/pim/employee/{n}/contact-details`.

## Seeded data

Employees/users `alice`/`bob` in all three apps (identity = e-mail), customer
`ACME Corp` and project `Phoenix Rollout` in Dolibarr + Kimai (linked to the
customer in both — the relation probe), a Kimai timesheet entry, an activity
`Code Review`, and per-app honesty records (a draft invoice in Dolibarr).
Dolibarr time-spent is deliberately NOT seeded: `POST /tasks/{id}/addtimespent`
is broken upstream in 23.0.3 (see below).

## Expected mappings

Ground truth: [ground-truth.yaml](ground-truth.yaml). Highlights:

| Pair | Character | Flagship transforms |
|---|---|---|
| OrangeHRM employees ↔ Kimai/Dolibarr users | HR→tooling provisioning | `workEmail`→`email` identity, `firstName+lastName`→`alias` aggregate/split |
| Dolibarr thirdparties ↔ Kimai customers | clean business pair | `name` identity, `country_code`→`country` |
| Dolibarr projects ↔ Kimai projects | relation probe | `title`→`name`; **`socid`→`customer` needs the customers RecordLink** — outside today's transform vocabulary |
| Dolibarr time-spent ↔ Kimai timesheets ↔ OrangeHRM attendance | 3 time-ish resources | pairwise partial only — deliberately no clean 3-way |

Negatives: Kimai activities↔Dolibarr tasks (category vs work item), invoices/
products/leave/performance (no counterpart), OrangeHRM system-users as the
ambiguous second user pairing.

## Concept probes built into this scenario

- **Relation-shaped mappings**: `socid`↔`customer` (and timesheet `user`
  references) need cross-app id translation via RecordLinks — FieldMapping
  transforms cannot express this today.
- **Response envelopes**: OrangeHRM wraps everything in `{data, meta, rels}` —
  field paths in mappings must reach through the envelope.
- **Timestamp dialects**: Dolibarr epoch-seconds (often as strings) vs Kimai
  RFC 3339 vs OrangeHRM split date/time fields.
- **The spec lies**: Dolibarr's `POST /tasks/{id}/addtimespent` exists in the
  spec but fatals at runtime (Restler validator bug) — sync execution must
  fail gracefully on a mapped-and-approved operation.
- **Auth diversity**: header API key (DOLAPIKEY), Bearer token, session cookie
  (+ OAuth2 for a real mediator) — one landscape, three credential types
  (docs/architecture/security.md).
