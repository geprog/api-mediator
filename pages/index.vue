<template>
  <v-network-graph
    class="w-full h-full"
    :nodes="nodes"
    :edges="edges"
    :configs="configs"
  >
    <template #edge-label="{ edge, ...slotProps }">
      <v-edge-label
        :text="edge.label"
        align="center"
        vertical-align="above"
        v-bind="slotProps"
      />
    </template>
  </v-network-graph>
  <footer
    class="flex w-full items-center justify-center gap-4 border-t border-gray-300 bg-white p-4"
  >
    <UButton icon="i-heroicons-plus-circle" to="/api/add">New Api</UButton>
    <UButton icon="i-heroicons-plus-circle" to="/mapping/add"
      >New Mapping</UButton
    >
  </footer>
</template>

<script setup lang="ts">
import * as vNG from 'v-network-graph';
import {
  ForceLayout,
  type ForceNodeDatum,
  type ForceEdgeDatum,
} from 'v-network-graph/lib/force-layout';

const { data: apis } = await useFetch('/api/api', { default: () => [] });
const { data: mappings } = await useFetch('/api/mapping', {
  default: () => [],
});
const nodes = computed<vNG.Nodes>(() => {
  return apis.value.reduce(
    (nodes, api) => ({
      ...nodes,
      [api.id]: api,
    }),
    {},
  );
});

const edges = computed<vNG.Edges>(() => {
  return mappings.value.reduce((edges, mapping) => {
    return {
      ...edges,
      [mapping.id]: {
        source: mapping.parts[0].api,
        target: mapping.parts[1].api,
        label: mapping.name,
      },
    };
  }, {});
});

const configs = vNG.defineConfigs({
  view: {
    layoutHandler: new ForceLayout({
      createSimulation(d3, nodes, edges) {
        const forceLink = d3
          .forceLink<ForceNodeDatum, ForceEdgeDatum>(edges)
          .id((d: { id: string }) => d.id);
        return d3
          .forceSimulation(nodes)
          .force('edge', forceLink.distance(150).strength(0.2))
          .force('charge', d3.forceManyBody().strength(-120))
          .alphaMin(0.001);
      },
    }),
  },
  node: {
    normal: {
      color: '#4466cc',
    },
    label: {
      visible: true,
    },
  },
});
</script>
