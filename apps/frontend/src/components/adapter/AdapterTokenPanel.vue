<script setup lang="ts">
import type { IssueAdapterTokenResponse } from "@mediator/contracts";
import Button from "primevue/button";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, ref } from "vue";

import {
  useCutoverAdapterToken,
  useIssueAdapterToken,
  useRotateAdapterToken,
} from "../../composables/useAdapterToken.js";

/**
 * CU-3 — the adapter-token panel, where a consumer app's inbound token is shown
 * **exactly once**. Issue/rotate display the raw token a single time with an explicit
 * copy affordance and an unmistakable statement that it cannot be retrieved again;
 * the raw value lives **only** in transient component state (`rawToken` below) —
 * never a store, query cache, or `localStorage` — so a reload / navigate-away /
 * reopen never shows it again (AT-1.2 / CU-3.2). A viewer sees no controls and no
 * token value ever (OA-2). The mediator stores only a salted hash, so no read can
 * echo the token back.
 *
 * Known backend gap (documented in `api/adapter-token.ts`): there is currently no
 * AP-4 read for token **metadata** (existence / `lastRotatedAt` / overlap) nor for
 * the consumer's adapter base URL, so the metadata shown here reflects only what
 * this session's issue/rotate/cutover returned and does not survive a cold reload;
 * the auth scheme is stated exactly (Bearer), and the base URL is shown from
 * `adapterBaseUrl` when the host provides it.
 */
const props = defineProps<{
  consumerAppId: string;
  consumerAppName?: string;
  /**
   * The consumer's adapter surface base URL (host/port), when the deployment exposes
   * it to the UI (CU-3.4). Absent = not exposed by the current API; the panel then
   * states the auth scheme and notes the host/port is deployment configuration.
   */
  adapterBaseUrl?: string;
  readonly: boolean;
}>();

const issue = useIssueAdapterToken();
const rotate = useRotateAdapterToken();
const cutover = useCutoverAdapterToken();

/** The raw token — the ONLY place it ever lives. Reset on dismiss and gone on unmount. */
const rawToken = ref<string | null>(null);
/** Whether the last shown token came from a rotation (drives the overlap-window statement). */
const shownFromRotation = ref<boolean>(false);
/** Session-scoped metadata — not persisted, not readable back (see the backend-gap note). */
const tokenIssuedThisSession = ref<boolean>(false);
const lastRotatedAt = ref<string | null>(null);
const overlapActive = ref<boolean>(false);
const actionError = ref<string | null>(null);
const copied = ref<boolean>(false);

const pending = computed<boolean>(
  () => issue.isPending.value || rotate.isPending.value || cutover.isPending.value,
);

/** Adopt a freshly issued/rotated token into transient state, then reset the mutation. */
function adoptToken(result: IssueAdapterTokenResponse, fromRotation: boolean): void {
  rawToken.value = result.token;
  shownFromRotation.value = fromRotation;
  tokenIssuedThisSession.value = true;
  copied.value = false;
  if (result.rotated || fromRotation) {
    overlapActive.value = true;
    lastRotatedAt.value = result.issuedAt;
  }
  // Do not leave the raw value on the mutation observer's `data`.
  issue.reset();
  rotate.reset();
}

function onIssue(): void {
  actionError.value = null;
  issue.mutate(props.consumerAppId, {
    onSuccess: (result) => adoptToken(result, false),
    onError: (error) => (actionError.value = error.message),
  });
}

function onRotate(): void {
  actionError.value = null;
  rotate.mutate(props.consumerAppId, {
    onSuccess: (result) => adoptToken(result, true),
    onError: (error) => (actionError.value = error.message),
  });
}

function onCutover(): void {
  actionError.value = null;
  cutover.mutate(props.consumerAppId, {
    onSuccess: () => {
      overlapActive.value = false;
    },
    onError: (error) => (actionError.value = error.message),
  });
}

async function copyToken(): Promise<void> {
  if (rawToken.value === null) return;
  try {
    await navigator.clipboard?.writeText(rawToken.value);
    copied.value = true;
  } catch {
    // Clipboard access can be denied; the value is still visible to copy manually.
    copied.value = false;
  }
}

/** Dismiss the one-time display — the operator confirms they have copied it. */
function dismissToken(): void {
  rawToken.value = null;
}
</script>

<template>
  <section class="token-panel" data-testid="token-panel">
    <header class="token-panel__header">
      <h3>Adapter token</h3>
      <span v-if="consumerAppName !== undefined" class="token-panel__muted">{{
        consumerAppName
      }}</span>
    </header>

    <!-- The once-only raw token display (operator, immediately after issue/rotate) -->
    <div
      v-if="!readonly && rawToken !== null"
      class="token-panel__reveal"
      data-testid="token-reveal"
    >
      <Message severity="warn" data-testid="token-once-warning">
        This token is shown <strong>exactly once</strong>. Copy it now — the mediator stores only a
        salted hash, so it <strong>cannot be retrieved again</strong>. If you lose it, rotate to
        issue a new one.
      </Message>
      <div class="token-panel__value-row">
        <code class="token-panel__value" data-testid="token-value">{{ rawToken }}</code>
        <Button size="small" label="Copy" data-testid="token-copy" @click="copyToken" />
        <Tag v-if="copied" severity="success" value="copied" data-testid="token-copied" />
      </div>

      <Message v-if="shownFromRotation" severity="info" data-testid="token-overlap-note">
        The <strong>previous token stays valid</strong> during the rotation overlap window until you
        confirm cutover or the window elapses. Hand the new token to the consumer team, then confirm
        cutover once they have switched over.
      </Message>

      <div class="token-panel__reveal-actions">
        <Button
          size="small"
          severity="secondary"
          label="I've copied it — hide"
          data-testid="token-dismiss"
          @click="dismissToken"
        />
      </div>
    </div>

    <!-- Metadata (existence / lastRotatedAt / overlap) — no token value -->
    <div class="token-panel__meta" data-testid="token-metadata">
      <p class="token-panel__row">
        <span>Token:</span>
        <Tag
          v-if="tokenIssuedThisSession"
          severity="success"
          value="issued"
          data-testid="token-exists"
        />
        <Tag
          v-else
          severity="secondary"
          value="not issued this session"
          data-testid="token-absent"
        />
      </p>
      <p v-if="lastRotatedAt !== null" class="token-panel__row" data-testid="token-last-rotated">
        <span>Last rotated:</span> <code>{{ lastRotatedAt }}</code>
      </p>
      <p v-if="overlapActive" class="token-panel__row" data-testid="token-overlap-active">
        <Tag severity="warn" value="rotation overlap in progress" />
        <span
          >the previous token is still valid until cutover is confirmed or the window elapses.</span
        >
      </p>
      <p class="token-panel__note">
        Metadata reflects this session only — the backend does not yet expose a token-metadata read,
        so a cold reload cannot re-derive existence / last-rotated / overlap.
      </p>
    </div>

    <!-- CU-3.4 — operational handoff: base URL / host-port + auth scheme -->
    <div class="token-panel__handoff" data-testid="token-handoff">
      <h4>Consumer handoff</h4>
      <p class="token-panel__row">
        <span>Auth scheme:</span>
        <code data-testid="token-auth-scheme">Authorization: Bearer &lt;adapter token&gt;</code>
      </p>
      <p v-if="adapterBaseUrl !== undefined" class="token-panel__row" data-testid="token-base-url">
        <span>Adapter base URL:</span> <code>{{ adapterBaseUrl }}</code>
      </p>
      <p v-else class="token-panel__note" data-testid="token-base-url-unknown">
        The consumer calls its generated adapter surface with the token in the
        <code>Authorization: Bearer</code> header. The concrete host/port is deployment
        configuration and is not exposed by the current API.
      </p>
    </div>

    <Message v-if="actionError !== null" severity="error" data-testid="token-error">
      {{ actionError }}
    </Message>

    <!-- Operator controls -->
    <div v-if="!readonly" class="token-panel__actions" data-testid="token-actions">
      <Button
        v-if="!tokenIssuedThisSession"
        label="Issue token"
        :loading="pending"
        data-testid="token-issue"
        @click="onIssue"
      />
      <Button
        v-else
        label="Rotate token"
        severity="secondary"
        :loading="pending"
        data-testid="token-rotate"
        @click="onRotate"
      />
      <Button
        v-if="overlapActive"
        label="Confirm cutover"
        severity="secondary"
        :loading="pending"
        data-testid="token-cutover"
        @click="onCutover"
      />
    </div>
    <p v-else class="token-panel__muted" data-testid="token-readonly">
      You have viewer access — issuing and rotating tokens is operator-only, and no token value is
      ever shown.
    </p>
  </section>
</template>

<style scoped>
.token-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
}

.token-panel__header {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}

.token-panel__reveal,
.token-panel__meta,
.token-panel__handoff {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.token-panel__value-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.token-panel__value {
  padding: 0.4rem 0.6rem;
  background: var(--p-content-hover-background, #f1f5f9);
  border-radius: 4px;
  word-break: break-all;
}

.token-panel__row {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.token-panel__muted,
.token-panel__note {
  margin: 0;
  color: var(--p-text-muted-color, #64748b);
}

.token-panel__note {
  font-size: 0.8rem;
  font-style: italic;
}

.token-panel__actions {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
}
</style>
