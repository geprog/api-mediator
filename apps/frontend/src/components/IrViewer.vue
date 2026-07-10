<script setup lang="ts">
import type { Ir } from "@mediator/domain";
import Card from "primevue/card";
import Tag from "primevue/tag";

/**
 * IR viewer (SI-3): renders the parsed IR — resource groups, each drillable into
 * its operations (method, path, summary, parameters, request/response schema
 * `operationId`) and flattened schema fields (name, type, required-ness). Derived
 * from the OpenAPI document only, so it can never contain credential material
 * (SI-3 criterion 4). Operation/schema detail lives in `<details>` disclosures.
 */
defineProps<{ ir: Ir }>();
</script>

<template>
  <div class="ir-viewer" data-testid="ir-viewer">
    <p v-if="ir.length === 0" data-testid="ir-empty">This spec has no resource groups.</p>

    <Card
      v-for="group in ir"
      :key="group.resourceRef"
      class="ir-group"
      :data-testid="`ir-group-${group.resourceRef}`"
    >
      <template #title>
        <span class="ir-group__title">{{ group.name }}</span>
        <Tag severity="secondary" :value="group.resourceRef" class="ir-group__ref" />
      </template>
      <template #subtitle>
        {{ group.operations.length }} operation(s), {{ group.schemas.length }} schema(s)
      </template>

      <template #content>
        <section v-if="group.operations.length > 0" class="ir-section">
          <h4>Operations</h4>
          <details
            v-for="operation in group.operations"
            :key="`${operation.operationId}-${operation.method}-${operation.path}`"
            class="ir-operation"
            :data-testid="`ir-operation-${operation.operationId}`"
          >
            <summary>
              <Tag :value="operation.method.toUpperCase()" class="ir-operation__method" />
              <code class="ir-operation__path">{{ operation.path }}</code>
              <span class="ir-operation__id">{{ operation.operationId }}</span>
            </summary>

            <p v-if="operation.summary" class="ir-operation__summary">{{ operation.summary }}</p>

            <div v-if="operation.parameters.length > 0" class="ir-params">
              <h5>Parameters</h5>
              <ul>
                <li v-for="parameter in operation.parameters" :key="parameter.name">
                  <code>{{ parameter.name }}</code>
                  <Tag severity="secondary" :value="parameter.location" />
                  <span v-if="parameter.type">: {{ parameter.type }}</span>
                  <Tag
                    :severity="parameter.required ? 'warn' : 'secondary'"
                    :value="parameter.required ? 'required' : 'optional'"
                  />
                </li>
              </ul>
            </div>

            <div v-if="operation.requestSchema" class="ir-op-schema">
              <h5>Request: {{ operation.requestSchema.name }}</h5>
              <ul>
                <li v-for="field in operation.requestSchema.fields" :key="field.name">
                  <code>{{ field.name }}</code
                  >: {{ field.type }}
                  <Tag
                    :severity="field.required ? 'warn' : 'secondary'"
                    :value="field.required ? 'required' : 'optional'"
                  />
                </li>
              </ul>
            </div>

            <div v-if="operation.responseSchema" class="ir-op-schema">
              <h5>Response: {{ operation.responseSchema.name }}</h5>
              <ul>
                <li v-for="field in operation.responseSchema.fields" :key="field.name">
                  <code>{{ field.name }}</code
                  >: {{ field.type }}
                  <Tag
                    :severity="field.required ? 'warn' : 'secondary'"
                    :value="field.required ? 'required' : 'optional'"
                  />
                </li>
              </ul>
            </div>
          </details>
        </section>

        <section v-if="group.schemas.length > 0" class="ir-section">
          <h4>Schemas</h4>
          <details
            v-for="schema in group.schemas"
            :key="schema.name"
            class="ir-schema"
            :data-testid="`ir-schema-${schema.name}`"
          >
            <summary>{{ schema.name }} ({{ schema.fields.length }} field(s))</summary>
            <ul>
              <li
                v-for="field in schema.fields"
                :key="field.name"
                :data-testid="`ir-field-${field.name}`"
              >
                <code>{{ field.name }}</code
                >: {{ field.type }}
                <Tag
                  :severity="field.required ? 'warn' : 'secondary'"
                  :value="field.required ? 'required' : 'optional'"
                />
                <span v-if="field.description" class="ir-field__desc">
                  — {{ field.description }}</span
                >
              </li>
            </ul>
          </details>
        </section>

        <section v-if="group.crossResourceRefs.length > 0" class="ir-section">
          <h4>Referenced schemas</h4>
          <ul>
            <li v-for="summary in group.crossResourceRefs" :key="summary.name">
              <code>{{ summary.name }}</code>
              <span class="ir-field__desc"> — {{ summary.fields.join(", ") }}</span>
            </li>
          </ul>
        </section>
      </template>
    </Card>
  </div>
</template>

<style scoped>
.ir-viewer {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.ir-group__title {
  margin-right: 0.5rem;
}

.ir-section {
  margin-top: 0.75rem;
}

.ir-operation,
.ir-schema {
  margin: 0.35rem 0;
  padding: 0.35rem 0;
  border-top: 1px solid var(--p-content-border-color, #e2e8f0);
}

.ir-operation summary,
.ir-schema summary {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.ir-operation__id {
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.85rem;
}

.ir-params ul,
.ir-op-schema ul {
  margin: 0.25rem 0;
}

.ir-field__desc {
  color: var(--p-text-muted-color, #64748b);
}
</style>
