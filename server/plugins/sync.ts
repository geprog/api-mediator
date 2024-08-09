import type { Api, Mapping, MappingPart } from '~/server/utils/types';
import { doFetch } from '~/server/utils/useApi';
import { getMappedId, setMappedId } from '~/server/utils/useMappingCache';

export default defineNitroPlugin(async () => {
  while (true) {
    const mappings: Mapping[] = await loadData<Mapping>(FILES.mappings);
    console.log('###### Starting sync round #########');
    for (const mapping of mappings) {
      console.log('==> sync mapping', mapping.name);
      try {
        await sync(mapping, mapping.parts[0], mapping.parts[1]);
        await sync(mapping, mapping.parts[1], mapping.parts[0]);
      } catch (error) {
        console.error('Error occurred at syncing mapping', mapping.name, error);
      }
      console.log('<== mapping synced', mapping.name);
    }
    console.log('###### Sync round finished #########');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
});

async function sync(
  mapping: Mapping,
  source: MappingPart,
  target: MappingPart,
): Promise<void> {
  if (!source.getAll || !target.create || !target.update) {
    return;
  }
  const sourceApi = (await $fetch(`/api/api/${source.api}`)) as Api;
  const targetApi = (await $fetch(`/api/api/${target.api}`)) as Api;
  console.log(`######## Sync ${sourceApi.name} => ${targetApi.name} #########`);
  // sync the data
  // 1. fetch endpoint from source
  const sourceResponse = await fetch(
    `${sourceApi.baseUrl}${source.getAll.path}`,
    {
      method: source.getAll.method,
    },
  );
  const sourceItems = (await sourceResponse.json()) as Record<
    string,
    unknown
  >[];
  console.log(`syncing ${sourceItems.length} items`);

  // 2. update or create source items in target
  for (const sourceItem of sourceItems) {
    console.log('handling sourceItem ', sourceItem);

    let baseTargetItem: Record<string, unknown> = {};
    const sourceId = sourceItem.id;
    const targetId = await getMappedId(mapping, sourceApi, targetApi, sourceId);
    console.log('source item already exists in target', targetId);
    if (targetId) {
      // TODO: generalize parameter substitutions
      if (target.getOne) {
        baseTargetItem = await doFetch(targetApi, target.getOne, {
          id: targetId,
        });
      } else if (target.getAll) {
        const targetItems = await doFetch(targetApi, target.getAll, {});
        baseTargetItem = targetItems.find((item) => item.id === targetId);
        if (!baseTargetItem) {
          console.log(
            'Can not find target item',
            targetId,
            'Continuing with creating a new target item',
          );
          baseTargetItem = {};
        }
      } else {
        console.log('No endpoint to load existing target item', targetId);
        continue;
      }
      console.log('loaded existing target item', baseTargetItem);
    }

    const targetItem = Object.entries(source.fieldMapping).reduce<
      Record<string, unknown>
    >((item, [sourceProp, targetProp]) => {
      if (sourceProp === 'id') {
        // TODO: primary key detection
        return item;
      }
      return {
        ...item,
        [targetProp]: sourceItem[sourceProp],
      };
    }, baseTargetItem);
    console.log('mapped source item to targetItem ', targetItem);

    // 3. execute endpoint at target
    if (targetId) {
      // 3.1. update target entity because it was existing before
      const responseData = await doFetch(
        targetApi,
        target.update,
        { id: targetId },
        targetItem,
      );
      console.log('updated target item ', responseData);
    } else {
      // 3.2. create if not existing and save id mapping
      const { id, ...targetItemWithoutId } = targetItem;
      const responseData = await doFetch(
        targetApi,
        target.create,
        {},
        targetItemWithoutId,
      );
      console.log('created target item ', responseData);
      await setMappedId(
        mapping,
        sourceApi,
        targetApi,
        sourceId,
        responseData.id,
      );
    }
  }
}
