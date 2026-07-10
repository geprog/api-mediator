<script setup lang="ts">
import type { ValidationIssue } from "@mediator/contracts";
import { apiSpecRoleSchema } from "@mediator/domain";
import Button from "primevue/button";
import Card from "primevue/card";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import { computed, reactive, ref } from "vue";
import { useRouter } from "vue-router";

import { ApiError } from "../../api/errors.js";
import { readOpenApiDocument } from "../../api/spec-file.js";
import { useRegisterApp } from "../../composables/useApps.js";
import { usePreviewParse } from "../../composables/useSpecs.js";
import {
  CREDENTIAL_FORM_TYPES,
  createEmptyFormState,
  createEmptySpec,
  prepareRegistration,
  requiresBaseUrl,
  type CredentialFormType,
} from "./registration-model.js";

/**
 * App registration form (AR-1/AR-3). Reactive state lives here; validation and
 * request assembly are delegated to the pure `registration-model`. On submit it
 * validates client-side (mirroring AR-1's server rules for UX), then issues one
 * `POST /api/apps`; on success it navigates to the created app, on a 400 it
 * renders the field-level `ErrorResponse.issues` inline without losing input.
 *
 * Credential material is write-only (CR-2): the inputs are `type="password"` and
 * are never populated from server data (no endpoint returns a stored secret), and
 * `adapterToken` is not an offered type (CR-1 criterion 5).
 */
const router = useRouter();
const registerMutation = useRegisterApp();
const previewMutation = usePreviewParse();

const form = reactive(createEmptyFormState());
const submissionIssues = ref<ValidationIssue[]>([]);
const generalError = ref<string | null>(null);

const roleOptions = apiSpecRoleSchema.options;
const baseUrlRequired = computed<boolean>(() => requiresBaseUrl(form));

function issuesFor(path: string): ValidationIssue[] {
  return submissionIssues.value.filter(
    (issue) => issue.path === path || issue.path.startsWith(`${path}.`),
  );
}

function onFileChange(index: number, event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const file = input.files?.[0];
  if (file === undefined) {
    return;
  }
  void loadSpecFile(index, file);
}

async function loadSpecFile(index: number, file: File): Promise<void> {
  const spec = form.specs[index];
  if (spec === undefined) {
    return;
  }
  spec.error = null;
  spec.fileName = file.name;
  spec.document = null;
  spec.resourceGroups = [];
  spec.excludedRefs = [];

  let document: Record<string, unknown>;
  try {
    document = await readOpenApiDocument(file);
  } catch (error) {
    spec.error = error instanceof Error ? error.message : "Could not read the uploaded file.";
    return;
  }
  spec.document = document;

  try {
    const preview = await previewMutation.mutateAsync({ document });
    spec.resourceGroups = preview.resourceGroups;
  } catch (error) {
    spec.error =
      error instanceof ApiError
        ? error.message
        : "The document could not be preview-parsed as an OpenAPI 3.x spec.";
  }
}

function onRoleChange(index: number, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  const parsed = apiSpecRoleSchema.safeParse(target.value);
  const spec = form.specs[index];
  if (parsed.success && spec !== undefined) {
    spec.role = parsed.data;
  }
}

function toggleExclusion(index: number, resourceRef: string): void {
  const spec = form.specs[index];
  if (spec === undefined) {
    return;
  }
  spec.excludedRefs = spec.excludedRefs.includes(resourceRef)
    ? spec.excludedRefs.filter((ref) => ref !== resourceRef)
    : [...spec.excludedRefs, resourceRef];
}

function addSpec(): void {
  form.specs.push(createEmptySpec());
}

function removeSpec(index: number): void {
  if (form.specs.length > 1) {
    form.specs.splice(index, 1);
  }
}

function onIntervalInput(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  const value = target.value.trim();
  form.capabilities.defaultPollInterval = value === "" ? null : Number(value);
}

function onCredentialTypeChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  const match: CredentialFormType | undefined = CREDENTIAL_FORM_TYPES.find(
    (type) => type === target.value,
  );
  if (match !== undefined) {
    form.credential.type = match;
  }
}

function addCustomEntry(): void {
  form.credential.customEntries.push({ key: "", value: "" });
}

function removeCustomEntry(index: number): void {
  form.credential.customEntries.splice(index, 1);
}

function onSubmit(): void {
  generalError.value = null;
  const prepared = prepareRegistration(form);
  if (prepared.status === "invalid") {
    submissionIssues.value = prepared.issues;
    return;
  }
  submissionIssues.value = [];
  registerMutation.mutate(prepared.request, {
    onSuccess: (response) => {
      void router.push({ name: "app-detail", params: { id: response.app.id } });
    },
    onError: (error) => {
      submissionIssues.value = [...error.issues];
      generalError.value = error.issues.length > 0 ? null : error.message;
    },
  });
}
</script>

<template>
  <form class="reg-form" data-testid="registration-form" @submit.prevent="onSubmit">
    <Card>
      <template #title>Register an app</template>
      <template #content>
        <div class="reg-field">
          <label for="reg-name">Name</label>
          <InputText id="reg-name" v-model="form.name" data-testid="reg-name" />
          <small
            v-for="issue in issuesFor('name')"
            :key="issue.message"
            class="reg-error"
            data-testid="reg-name-error"
            >{{ issue.message }}</small
          >
        </div>

        <div class="reg-field">
          <label for="reg-base-url">
            Base URL
            <span v-if="baseUrlRequired" class="reg-required">(required for PROVIDER)</span>
          </label>
          <InputText id="reg-base-url" v-model="form.baseUrl" data-testid="reg-base-url" />
          <small
            v-for="issue in issuesFor('baseUrl')"
            :key="issue.message"
            class="reg-error"
            data-testid="reg-base-url-error"
            >{{ issue.message }}</small
          >
        </div>
      </template>
    </Card>

    <Card>
      <template #title>Capabilities</template>
      <template #content>
        <label class="reg-checkbox">
          <input
            v-model="form.capabilities.declare"
            type="checkbox"
            data-testid="reg-cap-declare"
          />
          Declare capabilities (otherwise the server applies conservative defaults)
        </label>

        <div v-if="form.capabilities.declare" class="reg-capabilities">
          <label class="reg-checkbox">
            <input
              v-model="form.capabilities.supportsPolling"
              type="checkbox"
              data-testid="reg-cap-polling"
            />
            supportsPolling
          </label>
          <label class="reg-checkbox">
            <input
              v-model="form.capabilities.supportsDeltaQuery"
              type="checkbox"
              data-testid="reg-cap-delta"
            />
            supportsDeltaQuery
          </label>
          <label class="reg-checkbox">
            <input
              v-model="form.capabilities.supportsChangeTimestamps"
              type="checkbox"
              data-testid="reg-cap-timestamps"
            />
            supportsChangeTimestamps
          </label>
          <div class="reg-field">
            <label for="reg-poll-interval">Default poll interval (ms)</label>
            <input
              id="reg-poll-interval"
              type="number"
              min="1"
              :value="form.capabilities.defaultPollInterval ?? ''"
              data-testid="reg-poll-interval"
              @input="onIntervalInput"
            />
            <small
              v-for="issue in issuesFor('capabilities.defaultPollInterval')"
              :key="issue.message"
              class="reg-error"
              data-testid="reg-poll-interval-error"
              >{{ issue.message }}</small
            >
          </div>
        </div>
      </template>
    </Card>

    <Card>
      <template #title>Credential (optional, write-only)</template>
      <template #content>
        <label class="reg-checkbox">
          <input
            v-model="form.credentialEnabled"
            type="checkbox"
            data-testid="reg-credential-enable"
          />
          Add credential material
        </label>

        <div v-if="form.credentialEnabled" class="reg-credential">
          <div class="reg-field">
            <label for="reg-credential-type">Type</label>
            <select
              id="reg-credential-type"
              :value="form.credential.type"
              data-testid="reg-credential-type"
              @change="onCredentialTypeChange"
            >
              <option v-for="type in CREDENTIAL_FORM_TYPES" :key="type" :value="type">
                {{ type }}
              </option>
            </select>
          </div>

          <div v-if="form.credential.type === 'apiKey'" class="reg-field">
            <label for="reg-credential-apikey">API key</label>
            <InputText
              id="reg-credential-apikey"
              v-model="form.credential.apiKey"
              type="password"
              autocomplete="off"
              data-testid="reg-credential-apikey"
            />
            <small
              v-for="issue in issuesFor('credential.secret.apiKey')"
              :key="issue.message"
              class="reg-error"
              >{{ issue.message }}</small
            >
          </div>

          <template v-else-if="form.credential.type === 'basicAuth'">
            <div class="reg-field">
              <label for="reg-credential-username">Username</label>
              <InputText
                id="reg-credential-username"
                v-model="form.credential.username"
                autocomplete="off"
                data-testid="reg-credential-username"
              />
            </div>
            <div class="reg-field">
              <label for="reg-credential-password">Password</label>
              <InputText
                id="reg-credential-password"
                v-model="form.credential.password"
                type="password"
                autocomplete="off"
                data-testid="reg-credential-password"
              />
            </div>
          </template>

          <template v-else-if="form.credential.type === 'oauth2'">
            <div class="reg-field">
              <label for="reg-credential-access">Access token</label>
              <InputText
                id="reg-credential-access"
                v-model="form.credential.accessToken"
                type="password"
                autocomplete="off"
                data-testid="reg-credential-access"
              />
            </div>
            <div class="reg-field">
              <label for="reg-credential-refresh">Refresh token (optional)</label>
              <InputText
                id="reg-credential-refresh"
                v-model="form.credential.refreshToken"
                type="password"
                autocomplete="off"
                data-testid="reg-credential-refresh"
              />
            </div>
          </template>

          <template v-else-if="form.credential.type === 'custom'">
            <div
              v-for="(entry, entryIndex) in form.credential.customEntries"
              :key="entryIndex"
              class="reg-custom-entry"
            >
              <InputText
                v-model="entry.key"
                placeholder="key"
                :data-testid="`reg-credential-custom-key-${entryIndex}`"
              />
              <InputText
                v-model="entry.value"
                type="password"
                placeholder="value"
                autocomplete="off"
                :data-testid="`reg-credential-custom-value-${entryIndex}`"
              />
              <Button
                type="button"
                severity="secondary"
                size="small"
                label="Remove"
                @click="removeCustomEntry(entryIndex)"
              />
            </div>
            <Button
              type="button"
              severity="secondary"
              size="small"
              label="Add entry"
              data-testid="reg-credential-custom-add"
              @click="addCustomEntry"
            />
          </template>

          <div class="reg-field">
            <label for="reg-credential-scopes">Scopes (comma-separated, optional)</label>
            <InputText
              id="reg-credential-scopes"
              v-model="form.credential.scopes"
              data-testid="reg-credential-scopes"
            />
          </div>
        </div>
      </template>
    </Card>

    <Card>
      <template #title>Specs</template>
      <template #content>
        <div
          v-for="(spec, index) in form.specs"
          :key="index"
          class="reg-spec"
          :data-testid="`reg-spec-${index}`"
        >
          <div class="reg-field">
            <label :for="`spec-file-${index}`">OpenAPI document (JSON)</label>
            <input
              :id="`spec-file-${index}`"
              type="file"
              accept="application/json,.json"
              :data-testid="`spec-file-${index}`"
              @change="(event) => onFileChange(index, event)"
            />
            <small v-if="spec.fileName !== null" :data-testid="`spec-filename-${index}`">
              {{ spec.fileName }}
            </small>
            <small
              v-if="spec.error !== null"
              class="reg-error"
              :data-testid="`spec-error-${index}`"
              >{{ spec.error }}</small
            >
            <small
              v-for="issue in issuesFor(`specs.${index}.document`)"
              :key="issue.message"
              class="reg-error"
              :data-testid="`spec-document-error-${index}`"
              >{{ issue.message }}</small
            >
          </div>

          <div class="reg-field">
            <label :for="`spec-role-${index}`">Role</label>
            <select
              :id="`spec-role-${index}`"
              :value="spec.role"
              :data-testid="`spec-role-${index}`"
              @change="(event) => onRoleChange(index, event)"
            >
              <option v-for="role in roleOptions" :key="role" :value="role">{{ role }}</option>
            </select>
          </div>

          <div v-if="spec.resourceGroups.length > 0" class="reg-exclusions">
            <p class="reg-exclusions__title">Exclude resource groups from analysis</p>
            <label
              v-for="group in spec.resourceGroups"
              :key="group.resourceRef"
              class="reg-checkbox"
              :data-testid="`spec-group-${index}-${group.resourceRef}`"
            >
              <input
                type="checkbox"
                :checked="spec.excludedRefs.includes(group.resourceRef)"
                :data-testid="`spec-exclude-${index}-${group.resourceRef}`"
                @change="toggleExclusion(index, group.resourceRef)"
              />
              {{ group.name }} ({{ group.operationCount }} op) — {{ group.resourceRef }}
            </label>
          </div>

          <Button
            v-if="form.specs.length > 1"
            type="button"
            severity="secondary"
            size="small"
            label="Remove spec"
            :data-testid="`remove-spec-${index}`"
            @click="removeSpec(index)"
          />
        </div>

        <Button
          type="button"
          severity="secondary"
          size="small"
          label="Add another spec"
          data-testid="add-spec"
          @click="addSpec"
        />
      </template>
    </Card>

    <Message v-if="submissionIssues.length > 0" severity="error" data-testid="reg-issues">
      <ul class="reg-issues">
        <li v-for="issue in submissionIssues" :key="`${issue.path}:${issue.message}`">
          <strong>{{ issue.path }}</strong
          >: {{ issue.message }}
        </li>
      </ul>
    </Message>

    <Message v-if="generalError !== null" severity="error" data-testid="reg-error">
      {{ generalError }}
    </Message>

    <Button
      type="submit"
      label="Register app"
      data-testid="reg-submit"
      :loading="registerMutation.isPending.value"
    />
  </form>
</template>

<style scoped>
.reg-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 48rem;
}

.reg-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 0.75rem;
}

.reg-checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
}

.reg-capabilities,
.reg-credential {
  margin-top: 0.5rem;
  padding-left: 1rem;
  border-left: 2px solid var(--p-content-border-color, #e2e8f0);
}

.reg-spec {
  padding: 0.75rem 0;
  border-top: 1px solid var(--p-content-border-color, #e2e8f0);
}

.reg-custom-entry {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.reg-required {
  color: var(--p-primary-color, #6366f1);
  font-size: 0.85rem;
}

.reg-error {
  color: var(--p-red-500, #ef4444);
}

.reg-issues {
  margin: 0;
  padding-left: 1.25rem;
}

.reg-exclusions__title {
  font-weight: 600;
  margin: 0.5rem 0 0.25rem;
}
</style>
