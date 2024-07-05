<template>
  <UButton @click="backToHome">Cancel</UButton>
  <UCard>
    <template #header>Select the apis you want to map</template>
    <div class="flex flex-col gap-4">
      <UFormGroup label="First api">
        <USelect
          v-model="api1Id"
          :options="apiOptions"
          option-attribute="name"
        />
      </UFormGroup>
      <UFormGroup label="Second api">
        <USelect
          v-model="api2Id"
          :options="apiOptions"
          option-attribute="name"
        />
      </UFormGroup>
    </div>
  </UCard>
  <UCard>
    <template #header>Select the endpoints</template>
    <div class="flex flex-col gap-4">
      <div class="flex gap-4">
        <div class="flex w-1/2 flex-col gap-4">
          <div>{{ api1 ? api1.name : api1Id }}</div>
          <UCheckbox
            v-for="endpoint of endpoints1"
            v-model="selectedEndpoints1[endpoint]"
            :label="endpoint"
          />
        </div>
        <div class="flex w-1/2 flex-col gap-4">
          <div>{{ api2 ? api2.name : api2Id }}</div>
          <UCheckbox
            v-for="endpoint of endpoints2"
            v-model="selectedEndpoints2[endpoint]"
            :label="endpoint"
          />
        </div>
      </div>
      <UButton
        @click="generateEndpointMappings"
        :disabled="!api1 || !api2 || generating"
        :loading="generating"
      >
        Generate endpoint mappings
      </UButton>
    </div>
  </UCard>
  <UCard>
    <template #header>Select the Mappings you want to add</template>
    <div v-if="mappings" class="flex w-full flex-col gap-4">
      <UCard v-for="mapping of Object.keys(mappings)">
        <template #header>
          <UCheckbox v-model="selectedMappings[mapping]" :label="mapping" />
        </template>
        <div class="flex gap-4">
          <div class="flex w-1/2 flex-col gap-4">
            <pre>{{
              JSON.stringify(mappings[mapping].api1, undefined, 4)
            }}</pre>
          </div>
          <div class="flex w-1/2 flex-col gap-4">
            <pre>{{
              JSON.stringify(mappings[mapping].api2, undefined, 4)
            }}</pre>
          </div>
        </div>
      </UCard>
    </div>
    <UButton
      @click="addMappings"
      :disabled="!api1 || !api2 || adding"
      :loading="adding"
    >
      Add selected mappings
    </UButton>
  </UCard>
</template>

<script setup lang="ts">
import type { EndpointMappings } from '~/server/utils/types';

const { data: apis } = await useFetch('/api/api', { default: () => [] });
const apiOptions = computed(() => [
  { name: '', value: '' },
  ...apis.value.map((api) => ({
    name: api.name,
    value: api.id,
  })),
]);

const api1Id = ref('');
const api2Id = ref('');

const api1 = computed(() => {
  return apis.value.find((api) => api.id === api1Id.value);
});
const api2 = computed(() => {
  return apis.value.find((api) => api.id === api2Id.value);
});

const { data: endpoints1 } = await useFetch(
  () => `/api/api/${api1Id.value}/endpoints`,
);
const { data: endpoints2 } = await useFetch(
  () => `/api/api/${api2Id.value}/endpoints`,
);

const selectedEndpoints1 = ref<Record<string, boolean>>({});
const selectedEndpoints2 = ref<Record<string, boolean>>({});

const mappings = ref<EndpointMappings>({});
const generating = ref(false);
async function generateEndpointMappings() {
  generating.value = true;
  try {
    mappings.value = await $fetch('/api/mapping/generate', {
      method: 'POST',
      body: {
        api1: api1Id.value,
        api2: api2Id.value,
        endpoints1: Object.keys(selectedEndpoints1.value).filter(
          (endpoint) => selectedEndpoints1.value[endpoint],
        ),
        endpoints2: Object.keys(selectedEndpoints2.value).filter(
          (endpoint) => selectedEndpoints2.value[endpoint],
        ),
      },
    });
  } catch (error) {
    useToast().add({ title: 'Generating mappings failed', color: 'red' });
    console.error(error);
  }
  generating.value = false;
}

const selectedMappings = ref<Record<string, boolean>>({});
const adding = ref(false);
async function addMappings() {
  adding.value = true;
  try {
    for (const mappingKey of Object.keys(selectedMappings.value)) {
      if (!selectedMappings.value[mappingKey]) {
        continue;
      }
      await $fetch('/api/mapping/add', {
        method: 'POST',
        body: {
          api1: api1Id.value,
          api2: api2Id.value,
          name: mappingKey,
          mapping: mappings.value[mappingKey],
        },
      });
    }
  } catch (error) {
    useToast().add({ title: 'Adding mappings failed', color: 'red' });
    console.error(error);
  }
  adding.value = false;
}

async function backToHome() {
  await useRouter().push('/');
}
</script>
