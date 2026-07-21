<script setup lang="ts">
import type { ComposeAdapterEndpointPreviewResponse } from "@mediator/contracts";
import {
  PostMergeDedupMode,
  PostMergeFilterOperator,
  PostMergePaginationConvention,
  PostMergeSortDirection,
  type PostMergeDedup,
  type PostMergeFilter,
  type PostMergePaginationConventionValue,
  type PostMergeSort,
} from "@mediator/domain";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, reactive, ref, watch } from "vue";

import {
  isPaginationUnconfirmed,
  shouldNudgeDistinctOrders,
  type LinkDedupAvailability,
} from "./union-model.js";

/**
 * CU-2 — the `collection-union` composition panel. It surfaces the union's
 * post-merge semantics with the **consequence of leaving them unset stated up
 * front** (a skipped filter parameter makes requests using it fail — by design),
 * renders the sort/pagination heuristic as **unconfirmed** derive-then-confirm
 * state, gates link-based dedup on confirmed `nativeIdRef` provenance, and flags
 * the union-size risk. Everything is server-enforced (CO-3 / RP-2); the panel only
 * lets the composer make the decisions and shows what each one means.
 *
 * Presentational + editable-copy pattern: it owns an editable draft initialised from
 * props (like the sync identity-key panel) and emits the whole union config on any
 * change; the host `CompositionForm` merges it into the composition draft.
 */
type UnionAnalysis = NonNullable<ComposeAdapterEndpointPreviewResponse["union"]>;

const props = defineProps<{
  /** The CO-3 union derivations from the AP-2 preview, or `null` while it loads. */
  analysis: UnionAnalysis | null;
  /** Current draft dedup choice, or `null` when none has been chosen yet. */
  dedup: PostMergeDedup | null;
  /** Current draft post-merge filters (by consumer parameter). */
  filters: readonly PostMergeFilter[];
  /** Current draft post-merge sorts. */
  sorts: readonly PostMergeSort[];
  /** Current draft pagination convention (derive-then-confirm), or `null`. */
  pagination: PostMergePaginationConventionValue | null;
  /** Whether the pagination convention has been explicitly confirmed (CU-2.2). */
  paginationConfirmed: boolean;
  /** Whether link-based dedup may be offered — gated on confirmed `nativeIdRef` (CU-2.3). */
  linkDedupAvailability: LinkDedupAvailability;
  /** Consumer-schema field paths offered for a dedup key (CU-2.3). */
  dedupKeyFieldOptions: readonly string[];
  /** The contributing bindings' resolved execution orders — for the distinct-order nudge (CU-2.3). */
  contributingExecutionOrders: readonly number[];
  /** Whether a `cacheTtl` is configured on the endpoint (CU-2.4/2.5). */
  cacheTtlConfigured: boolean;
  readonly: boolean;
}>();

/** The whole union config portion of the composition draft, emitted on any change. */
export interface UnionConfigChange {
  readonly postMergeDedup: PostMergeDedup | null;
  readonly postMergeFilters: readonly PostMergeFilter[];
  readonly postMergeSorts: readonly PostMergeSort[];
  readonly postMergePagination: PostMergePaginationConventionValue | null;
  readonly confirmPostMergePagination: boolean;
}

const emit = defineEmits<{ change: [config: UnionConfigChange] }>();

// ── Filters (CU-2.1) ─────────────────────────────────────────────────────────
// One editable entry per consumer filter parameter the preview reports as
// unserviceable (neither pushed down nor configured). Leaving `fieldPath` empty
// keeps it unconfigured — requests using it are rejected, never answered unfiltered.
interface FilterEntry {
  fieldPath: string;
  operator: PostMergeFilter["operator"];
}
const filterEntries = reactive<Record<string, FilterEntry>>({});

// ── Sorts (CU-2.2) ───────────────────────────────────────────────────────────
interface SortEntry {
  fieldPath: string;
  direction: PostMergeSort["direction"];
}
const sortEntries = reactive<Record<string, SortEntry>>({});

// ── Dedup (CU-2.3) ───────────────────────────────────────────────────────────
type DedupChoice = "none" | "record-link" | "dedup-key";
const dedupChoice = ref<DedupChoice | null>(null);
const dedupKeyFieldPath = ref<string>("");

// ── Pagination (CU-2.2 derive-then-confirm) ──────────────────────────────────
type PaginationMode = "none" | "page-number" | "offset";
const paginationMode = ref<PaginationMode>("none");
const pageParamRef = ref<string>("");
const offsetParamRef = ref<string>("");
const sizeParamRef = ref<string>("");
const firstPageNumber = ref<number>(1);
const paginationConfirmedLocal = ref<boolean>(false);

/**
 * A stable signature of the union's **identifying inputs** — the set of filter / sort /
 * pagination parameters the preview reports needs a decision. The editable draft is
 * re-seeded only when THIS changes, never on the panel's own emitted prop echoes
 * (`filters`/`sorts`/`dedup`/`pagination`, which the host passes straight back with the
 * parameter sets unchanged). Re-seeding on every prop change would rebuild the entries
 * with new identities → recompute `built*` → re-emit → an infinite update loop.
 */
const seedKey = computed<string>(() =>
  JSON.stringify({
    filters: props.analysis?.unserviceableFilters ?? [],
    sorts: props.analysis?.unconfiguredSortParameters ?? [],
    pagination: props.analysis?.unconfiguredPaginationParameters ?? [],
  }),
);

/** (Re)initialise the editable draft from the current props — the persisted/initial values. */
function reseed(): void {
  for (const key of Object.keys(filterEntries)) delete filterEntries[key];
  for (const param of props.analysis?.unserviceableFilters ?? []) {
    const existing = props.filters.find((filter) => filter.consumerParamRef === param);
    filterEntries[param] = {
      fieldPath: existing?.consumerFieldPath ?? "",
      operator: existing?.operator ?? PostMergeFilterOperator.eq,
    };
  }
  for (const key of Object.keys(sortEntries)) delete sortEntries[key];
  for (const param of props.analysis?.unconfiguredSortParameters ?? []) {
    const existing = props.sorts.find((sort) => sort.consumerParamRef === param);
    sortEntries[param] = {
      fieldPath: existing?.consumerFieldPath ?? "",
      direction: existing?.direction ?? PostMergeSortDirection.asc,
    };
  }
  dedupChoice.value = props.dedup?.mode ?? null;
  dedupKeyFieldPath.value =
    props.dedup?.mode === PostMergeDedupMode["dedup-key"] ? props.dedup.dedupKeyFieldPath : "";
  const pagination = props.pagination;
  if (pagination === null) {
    paginationMode.value = "none";
  } else if (pagination.convention === PostMergePaginationConvention["page-number"]) {
    paginationMode.value = "page-number";
    pageParamRef.value = pagination.pageParamRef;
    sizeParamRef.value = pagination.sizeParamRef;
    firstPageNumber.value = pagination.firstPageNumber;
  } else {
    paginationMode.value = "offset";
    offsetParamRef.value = pagination.offsetParamRef;
    sizeParamRef.value = pagination.sizeParamRef;
  }
  paginationConfirmedLocal.value = props.paginationConfirmed;
}

watch(seedKey, reseed, { immediate: true });

const builtFilters = computed<PostMergeFilter[]>(() =>
  Object.entries(filterEntries)
    .filter(([, entry]) => entry.fieldPath.trim() !== "")
    .map(([param, entry]) => ({
      consumerParamRef: param,
      consumerFieldPath: entry.fieldPath.trim(),
      operator: entry.operator,
    })),
);

const builtSorts = computed<PostMergeSort[]>(() =>
  Object.entries(sortEntries)
    .filter(([, entry]) => entry.fieldPath.trim() !== "")
    .map(([param, entry]) => ({
      consumerParamRef: param,
      consumerFieldPath: entry.fieldPath.trim(),
      direction: entry.direction,
    })),
);

const builtDedup = computed<PostMergeDedup | null>(() => {
  switch (dedupChoice.value) {
    case null:
      return null;
    case "none":
      return { mode: PostMergeDedupMode.none };
    case "record-link":
      return { mode: PostMergeDedupMode["record-link"] };
    case "dedup-key":
      return dedupKeyFieldPath.value.trim() === ""
        ? null
        : {
            mode: PostMergeDedupMode["dedup-key"],
            dedupKeyFieldPath: dedupKeyFieldPath.value.trim(),
          };
  }
  return null;
});

const builtPagination = computed<PostMergePaginationConventionValue | null>(() => {
  if (paginationMode.value === "page-number") {
    if (pageParamRef.value.trim() === "" || sizeParamRef.value.trim() === "") return null;
    return {
      convention: PostMergePaginationConvention["page-number"],
      pageParamRef: pageParamRef.value.trim(),
      sizeParamRef: sizeParamRef.value.trim(),
      firstPageNumber: firstPageNumber.value,
    };
  }
  if (paginationMode.value === "offset") {
    if (offsetParamRef.value.trim() === "" || sizeParamRef.value.trim() === "") return null;
    return {
      convention: PostMergePaginationConvention.offset,
      offsetParamRef: offsetParamRef.value.trim(),
      sizeParamRef: sizeParamRef.value.trim(),
    };
  }
  return null;
});

/**
 * Emit the whole union config when an editable piece changes — guarded by **value
 * equality** so an echo that is deep-equal to what we last emitted (the host passing our
 * own value straight back as props) is a no-op, never a fresh emit. This, with the
 * `seedKey`-scoped re-seed above, keeps an edit from ping-ponging into a recursion loop.
 */
let lastEmitted = "";
watch([builtFilters, builtSorts, builtDedup, builtPagination, paginationConfirmedLocal], () => {
  const config: UnionConfigChange = {
    postMergeDedup: builtDedup.value,
    postMergeFilters: builtFilters.value,
    postMergeSorts: builtSorts.value,
    postMergePagination: builtPagination.value,
    confirmPostMergePagination: builtPagination.value !== null && paginationConfirmedLocal.value,
  };
  const serialized = JSON.stringify(config);
  if (serialized === lastEmitted) {
    return;
  }
  lastEmitted = serialized;
  emit("change", config);
});

const linkDedupAvailable = computed<boolean>(
  () => props.linkDedupAvailability.kind !== "unavailable",
);
const linkDedupMissing = computed<readonly string[]>(() =>
  props.linkDedupAvailability.kind === "unavailable"
    ? props.linkDedupAvailability.missingContributors
    : [],
);

const paginationUnconfirmed = computed<boolean>(() =>
  isPaginationUnconfirmed(builtPagination.value !== null, paginationConfirmedLocal.value),
);

const nudgeDistinctOrders = computed<boolean>(() =>
  shouldNudgeDistinctOrders(builtDedup.value, props.contributingExecutionOrders),
);

/** A pagination convention was entered but not yet confirmed → the confirm affordance shows. */
function confirmPagination(): void {
  paginationConfirmedLocal.value = true;
}
</script>

<template>
  <section class="union-panel" data-testid="union-panel">
    <h4>Union post-merge semantics</h4>
    <p class="union-panel__intro">
      This endpoint merges list results from several backends. Filtering, sorting and pagination do
      not distribute over a union, so the mediator applies them to the merged result — and only when
      you configure their semantics here. A parameter you leave unset is not answered loosely; a
      request that uses it is <strong>rejected</strong>.
    </p>

    <!-- CU-2.1 — filters -->
    <div class="union-panel__block" data-testid="union-filters">
      <h5>Filter parameters</h5>
      <p v-if="(analysis?.unserviceableFilters.length ?? 0) === 0" class="union-panel__muted">
        Every consumer filter parameter is pushed down to the backends (mapped in every contributing
        binding) — nothing to configure post-merge.
      </p>
      <ul v-else class="union-panel__list">
        <li
          v-for="param in analysis?.unserviceableFilters ?? []"
          :key="param"
          :data-testid="`union-filter-${param}`"
        >
          <div class="union-panel__row">
            <code>{{ param }}</code>
            <Tag
              v-if="(filterEntries[param]?.fieldPath ?? '').trim() === ''"
              severity="warn"
              value="needs post-merge semantics"
              :data-testid="`union-filter-unconfigured-${param}`"
            />
            <Tag v-else severity="success" value="post-merge configured" />
          </div>
          <p
            v-if="(filterEntries[param]?.fieldPath ?? '').trim() === ''"
            class="union-panel__consequence"
            :data-testid="`union-filter-consequence-${param}`"
          >
            Not pushed down and not configured — a request using
            <code>{{ param }}</code> is <strong>rejected</strong>, never answered unfiltered.
          </p>
          <div v-if="!readonly && filterEntries[param] !== undefined" class="union-panel__editor">
            <label>
              <span>consumer field</span>
              <input
                v-model="filterEntries[param]!.fieldPath"
                type="text"
                :data-testid="`union-filter-field-${param}`"
              />
            </label>
            <label>
              <span>operator</span>
              <select
                v-model="filterEntries[param]!.operator"
                :data-testid="`union-filter-op-${param}`"
              >
                <option v-for="op in ['eq', 'contains', 'gte', 'lte']" :key="op" :value="op">
                  {{ op }}
                </option>
              </select>
            </label>
          </div>
        </li>
      </ul>
    </div>

    <!-- CU-2.2 — sort (derive-then-confirm: needs an explicit decision) -->
    <div class="union-panel__block" data-testid="union-sorts">
      <h5>Sort parameters</h5>
      <p v-if="(analysis?.unconfiguredSortParameters.length ?? 0) === 0" class="union-panel__muted">
        No sort parameter still needs a decision.
      </p>
      <ul v-else class="union-panel__list">
        <li
          v-for="param in analysis?.unconfiguredSortParameters ?? []"
          :key="param"
          :data-testid="`union-sort-${param}`"
        >
          <div class="union-panel__row">
            <code>{{ param }}</code>
            <Tag
              v-if="(sortEntries[param]?.fieldPath ?? '').trim() === ''"
              severity="warn"
              value="unconfirmed"
              :data-testid="`union-sort-unconfirmed-${param}`"
            />
            <Tag v-else severity="success" value="configured" />
          </div>
          <p class="union-panel__consequence">
            Sort is never pushed down. Until you decide which consumer field it orders by, a request
            using <code>{{ param }}</code> is <strong>rejected</strong> — never returned unsorted.
          </p>
          <div v-if="!readonly && sortEntries[param] !== undefined" class="union-panel__editor">
            <label>
              <span>consumer field</span>
              <input
                v-model="sortEntries[param]!.fieldPath"
                type="text"
                :data-testid="`union-sort-field-${param}`"
              />
            </label>
            <label>
              <span>direction</span>
              <select
                v-model="sortEntries[param]!.direction"
                :data-testid="`union-sort-dir-${param}`"
              >
                <option v-for="dir in ['asc', 'desc']" :key="dir" :value="dir">{{ dir }}</option>
              </select>
            </label>
          </div>
        </li>
      </ul>
    </div>

    <!-- CU-2.2 — pagination (derive-then-confirm) -->
    <div class="union-panel__block" data-testid="union-pagination">
      <h5>Pagination convention</h5>
      <p class="union-panel__muted">
        Page N of each backend is not page N of the union, so pagination is applied post-merge. The
        convention is heuristically pre-filled but must be
        <strong>explicitly confirmed or corrected</strong> — it is never treated as chosen until you
        confirm it.
      </p>
      <p
        v-if="(analysis?.unconfiguredPaginationParameters.length ?? 0) > 0"
        class="union-panel__muted"
      >
        Parameters awaiting a convention:
        <code
          v-for="param in analysis?.unconfiguredPaginationParameters ?? []"
          :key="param"
          class="union-panel__chip"
          >{{ param }}</code
        >
      </p>
      <div v-if="!readonly" class="union-panel__editor union-panel__editor--column">
        <label>
          <span>convention</span>
          <select v-model="paginationMode" data-testid="union-pagination-mode">
            <option value="none">— not set —</option>
            <option value="page-number">page-number</option>
            <option value="offset">offset</option>
          </select>
        </label>
        <template v-if="paginationMode === 'page-number'">
          <label
            ><span>page param</span
            ><input v-model="pageParamRef" type="text" data-testid="union-pagination-page"
          /></label>
          <label
            ><span>size param</span
            ><input v-model="sizeParamRef" type="text" data-testid="union-pagination-size"
          /></label>
          <label
            ><span>first page number</span
            ><input
              v-model.number="firstPageNumber"
              type="number"
              data-testid="union-pagination-first"
          /></label>
        </template>
        <template v-else-if="paginationMode === 'offset'">
          <label
            ><span>offset param</span
            ><input v-model="offsetParamRef" type="text" data-testid="union-pagination-offset"
          /></label>
          <label
            ><span>size param</span
            ><input v-model="sizeParamRef" type="text" data-testid="union-pagination-size"
          /></label>
        </template>
      </div>
      <div class="union-panel__row">
        <Tag
          v-if="paginationUnconfirmed"
          severity="warn"
          value="unconfirmed"
          data-testid="union-pagination-unconfirmed"
        />
        <Tag
          v-else-if="paginationConfirmedLocal && builtPagination !== null"
          severity="success"
          value="confirmed"
          data-testid="union-pagination-confirmed"
        />
        <button
          v-if="!readonly && paginationUnconfirmed"
          type="button"
          data-testid="union-pagination-confirm"
          @click="confirmPagination"
        >
          Confirm pagination convention
        </button>
      </div>
    </div>

    <!-- CU-2.3 — dedup -->
    <div class="union-panel__block" data-testid="union-dedup">
      <h5>Duplicate collapsing (dedup)</h5>
      <fieldset :disabled="readonly" class="union-panel__dedup">
        <label class="union-panel__radio">
          <input v-model="dedupChoice" type="radio" value="none" data-testid="union-dedup-none" />
          <span>No dedup — duplicates are returned as mapped (an explicit choice).</span>
        </label>
        <label class="union-panel__radio">
          <input
            v-model="dedupChoice"
            type="radio"
            value="record-link"
            :disabled="!linkDedupAvailable"
            data-testid="union-dedup-record-link"
          />
          <span>
            Link-based — collapse rows the mediator knows are the same record (via RecordLinks).
          </span>
        </label>
        <p
          v-if="!linkDedupAvailable"
          class="union-panel__consequence"
          data-testid="union-dedup-record-link-reason"
        >
          Unavailable: link-based dedup needs every contributing backend resource to have a
          confirmed
          <code>nativeIdRef</code>. Missing:
          <code
            v-for="contributor in linkDedupMissing"
            :key="contributor"
            class="union-panel__chip"
            >{{ contributor }}</code
          >.
        </p>
        <p
          v-else-if="linkDedupAvailability.kind === 'server-enforced'"
          class="union-panel__note"
          data-testid="union-dedup-record-link-note"
        >
          Note: per-contributor <code>nativeIdRef</code> coverage is not exposed here, so link-based
          dedup is offered — but the server rejects it if any contributing backend resource lacks a
          confirmed <code>nativeIdRef</code>.
        </p>
        <label class="union-panel__radio">
          <input
            v-model="dedupChoice"
            type="radio"
            value="dedup-key"
            data-testid="union-dedup-key"
          />
          <span>Dedup key — collapse on a consumer-schema field.</span>
        </label>
        <label v-if="dedupChoice === 'dedup-key'" class="union-panel__editor">
          <span>dedup key field</span>
          <select
            v-if="dedupKeyFieldOptions.length > 0"
            v-model="dedupKeyFieldPath"
            data-testid="union-dedup-key-field"
          >
            <option value="">— choose —</option>
            <option v-for="field in dedupKeyFieldOptions" :key="field" :value="field">
              {{ field }}
            </option>
          </select>
          <input
            v-else
            v-model="dedupKeyFieldPath"
            type="text"
            data-testid="union-dedup-key-field"
          />
        </label>
      </fieldset>
      <Message v-if="nudgeDistinctOrders" severity="warn" data-testid="union-dedup-order-nudge">
        Give the contributing bindings distinct execution orders: with dedup on, field conflicts
        between duplicate rows are resolved by <code>executionOrder</code> precedence (ties broken
        by binding id).
      </Message>
    </div>

    <!-- CU-2.4 — cache coverage -->
    <div class="union-panel__block" data-testid="union-cache-coverage">
      <h5>Cache freshness coverage</h5>
      <p class="union-panel__muted">
        Cached union responses are invalidated by three signals: sync activity (only for backends
        that peer-sync), adapter writes (only for backends written through the adapter), and the
        <code>cacheTtl</code>. For a backend that is
        <strong>neither peer-synced nor written through the adapter</strong>, the TTL is the
        <strong>only</strong> bound on staleness.
      </p>
      <p v-if="!cacheTtlConfigured" class="union-panel__muted" data-testid="union-cache-none">
        No <code>cacheTtl</code> is set — responses are not cached.
      </p>
      <p class="union-panel__note">
        Note: per-backend invalidation coverage is not exposed by the current preview API, so the
        general rule above is stated rather than a per-backend breakdown.
      </p>
    </div>

    <!-- CU-2.5 — union size risk -->
    <Message
      v-if="analysis?.largeCollectionRisk.flagged"
      severity="warn"
      data-testid="union-size-risk"
    >
      This union can materialise a large merged collection every request (it is built in full before
      sorting and paging). <code>cacheTtl</code> is the practical mitigation
      <template v-if="!analysis.largeCollectionRisk.cacheTtlConfigured">
        — and none is set yet</template
      >. A request whose merged result exceeds the server's per-request row ceiling
      <strong>fails</strong> rather than being silently truncated.
    </Message>
  </section>
</template>

<style scoped>
.union-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
}

.union-panel__intro,
.union-panel__muted,
.union-panel__consequence,
.union-panel__note {
  margin: 0;
  color: var(--p-text-muted-color, #64748b);
}

.union-panel__note {
  font-size: 0.8rem;
  font-style: italic;
}

.union-panel__block {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.union-panel__block h5 {
  margin: 0;
}

.union-panel__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.union-panel__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.union-panel__editor {
  display: flex;
  gap: 0.75rem;
  align-items: flex-end;
  flex-wrap: wrap;
}

.union-panel__editor--column {
  flex-direction: column;
  align-items: flex-start;
}

.union-panel__editor label,
.union-panel__radio {
  display: flex;
  gap: 0.3rem;
}

.union-panel__editor label {
  flex-direction: column;
  font-size: 0.85rem;
}

.union-panel__dedup {
  border: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.union-panel__radio {
  flex-direction: row;
  align-items: baseline;
}

.union-panel__chip {
  margin-right: 0.3rem;
}
</style>
