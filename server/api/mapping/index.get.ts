import type { Mapping } from '~/server/utils/types';
import { FILES, loadData } from '~/server/utils/useFileStorage';

export default defineEventHandler(async (event) => {
  return await loadData<Mapping>(FILES.mappings);
});
