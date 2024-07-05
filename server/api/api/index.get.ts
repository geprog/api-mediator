import type { Api } from '~/server/utils/types';
import { FILES, loadData } from '~/server/utils/useFileStorage';

export default defineEventHandler(async (event) => {
  return await loadData<Api>(FILES.apis);
});
