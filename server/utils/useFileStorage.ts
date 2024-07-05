import path from 'node:path';

export const FILES = {
  apis: 'apis',
  mappings: 'mappings',
  mappingCache: 'mapping-cache',
};

export async function loadData<T>(filename: string): Promise<T[]> {
  const file = await getJsonFile(filename);
  const data = (await file.json()) as T[];
  return data;
}

export async function setData<T>(filename: string, data: T[]) {
  await Bun.write(
    await getJsonFile(filename),
    JSON.stringify(data, undefined, 2),
  );
}

async function getJsonFile(filename: string) {
  const config = useRuntimeConfig();
  const file = Bun.file(path.join(config.dataPath, `${filename}.json`));
  if (!(await file.exists())) {
    await Bun.write(file, '[]');
    return await getJsonFile(filename);
  }
  return file;
}
