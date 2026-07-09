# Flow: Graph / Overview Rendering

The user must always be able to see a graph of all registered apps and their connections. This is served by the Graph/Overview Service (see [architecture/overview.md](../architecture/overview.md)).

## Steps

1. The UI requests the graph, optionally filtered (by app, by status, by connection type).
2. The Graph Service returns:
   - **Nodes**: every `RegisteredApp` — including consumer-only apps, which are ordinary `RegisteredApp`s whose reachable endpoint happens to be mediator-hosted (see [architecture/data-model.md](../architecture/data-model.md)). There are no per-endpoint nodes: an app's adapter endpoints are detail on its edges, not nodes of their own.
   - **Edges**: `GraphEdge`s derived from `ApprovedMapping`-instantiated `SyncRule`s and `AdapterBinding`s, each carrying `type` (sync / adapter-dependency), `status`, and last-activity metadata sourced from `SyncEvent`/audit summaries. Sync edges run source app → target app, one edge per (app pair, direction), aggregating that direction's per-resource-pair `SyncRule`s; adapter-dependency edges run consumer app → backend app, one edge per (consumer, backend) app pair, aggregating that pair's `AdapterBinding`s. Per-resource and per-operation detail lives in the edge's `metadata`.
3. The Graph Service assembles `{ nodes, edges }` and returns it to the UI for rendering.

## Materialized projection

`GraphEdge` is maintained as a **materialized projection**, updated incrementally whenever:

- A `MappingApproved` event creates or updates a `SyncRule`/`AdapterBinding` (see [mapping-review-and-approval.md](mapping-review-and-approval.md)).
- A `SyncRule`/`AdapterBinding`'s effective status changes (e.g., paused because its `ApprovedMapping` was marked `stale` by a breaking spec change — see [architecture/extensibility.md](../architecture/extensibility.md)).
- A `SyncEvent` is recorded, updating an edge's last-activity metadata.

This keeps the overview responsive as sync/adapter activity grows, rather than recomputing the whole graph from first principles on every request.

The projection is also *recoverable*: every edge is derived from persisted `ApprovedMapping`/`SyncRule`/`AdapterBinding` state plus audit summaries, so a lost or suspect projection is rebuilt wholesale from that state — events keep it incremental, persisted state keeps it recoverable (the Event Bus is a decoupling seam, not a source of truth; see [architecture/overview.md](../architecture/overview.md)).

## Relationship to the Grafana landscape-health dashboard

The in-app graph view and the Grafana "Landscape health" dashboard (see [architecture/observability.md](../architecture/observability.md)) are complementary, not duplicates:

- The **Graph Service** shows the current *structural* connections in the landscape — what is mapped to what, right now.
- **Grafana** shows *operational health over time* — error rates, sync status trends, latency — for the same underlying apps and connections.
