import type { Api, Mapping } from './types';

type MappingCache = {
  mappingId: string;
  idMappings: {
    [api: string]: string | number;
  }[];
};

export async function getMappedId(
  mapping: Mapping,
  source: Api,
  target: Api,
  id: unknown,
): Promise<undefined | string | number> {
  const mappingCache = await getMappingCache(mapping);
  const idMapping = mappingCache.idMappings.find(
    (idMapping) => idMapping[source.id] === id,
  );
  if (!idMapping) {
    return undefined;
  }
  return idMapping[target.id];
}

export async function setMappedId(
  mapping: Mapping,
  source: Api,
  target: Api,
  sourceId: unknown,
  targetId: unknown,
): Promise<void> {
  const mappingCache = await getMappingCache(mapping);
  const idMapping = mappingCache.idMappings.find(
    (idMapping) => idMapping[source.id] === sourceId,
  );
  if (!idMapping) {
    mappingCache.idMappings.push({
      [source.id]: sourceId as string,
      [target.id]: targetId as string,
    });
  } else {
    idMapping[target.id] = targetId as string;
  }
  await setMappingCache(mapping, mappingCache);
}

async function getMappingCache(mapping: Mapping): Promise<MappingCache> {
  return (
    (await getMappingCaches()).find((m) => m.mappingId === mapping.id) || {
      mappingId: mapping.id,
      idMappings: [],
    }
  );
}

async function setMappingCache(
  mapping: Mapping,
  mappingCache: MappingCache,
): Promise<void> {
  const mappingCaches = await getMappingCaches();
  const index = mappingCaches.findIndex((m) => m.mappingId === mapping.id);
  if (index === -1) {
    await setMappingCaches([...mappingCaches, mappingCache]);
  } else {
    await setMappingCaches([
      ...mappingCaches.slice(0, index),
      mappingCache,
      ...mappingCaches.slice(index + 1),
    ]);
  }
}

async function getMappingCaches() {
  const file = await getMappingCacheFile();
  const cache = (await file.json()) as MappingCache[];
  return cache;
}

async function setMappingCaches(mappingCaches: MappingCache[]) {
  const file = Bun.file(`${import.meta.dir}/mapping-cache.json`);
  await Bun.write(file, JSON.stringify(mappingCaches, undefined, 2));
}

async function getMappingCacheFile() {
  const file = Bun.file(`${import.meta.dir}/mapping-cache.json`);
  if (!(await file.exists())) {
    await Bun.write(file, '[]');
    return await getMappingCacheFile();
  }
  return file;
}
