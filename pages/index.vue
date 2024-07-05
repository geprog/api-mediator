<template>
  <v-network-graph class="w-full h-full" :nodes="nodes" :edges="edges" />

  <footer
    class="flex w-full items-center justify-center border-t border-gray-300 bg-white p-4"
  >
    <UButton icon="i-heroicons-plus-circle" to="/api/add">New Api</UButton>
    <UButton icon="i-heroicons-plus-circle" to="/mapping/add"
      >New Mapping</UButton
    >
  </footer>
</template>

<script setup lang="ts">
const { data: apis } = await useFetch('/api/api', { default: () => [] });
const nodes = computed(() => {
  return apis.value.reduce(
    (nodes, api) => ({
      ...nodes,
      [api.id]: api,
    }),
    {},
  );
});
const edges = [];
</script>
