import type { Api } from '~/server/utils/types';

export default defineEventHandler(async (event) => {
  const apiId = await getRouterParam(event, 'apiId');
  const api = (await $fetch(`/api/api/${apiId}`)) as Api;

  return api.endpoints.map(
    (endpoint) => `${endpoint.method.toUpperCase()} ${endpoint.path}`,
  );
});
