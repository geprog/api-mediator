import type { Api } from '~/server/utils/types';
import { FILES, loadData } from '~/server/utils/useFileStorage';

export default defineEventHandler(async (event) => {
  const apiId = getRouterParam(event, 'apiId');
  const apis = await loadData<Api>(FILES.apis);
  return apis.find((api) => api.id === apiId);
});
