import { getEndpoint, parseOpenAPISpec } from './api';
import generateEndpointMappings from './generateEndpointMappings';
import { getFieldMappings } from './generateFieldMapping';
import sync from './sync';
import type {
  Api,
  Endpoint,
  EndpointMappings,
  Mapping,
  MappingPart,
} from './types';

async function main() {
  const api1 = await parseOpenAPISpec(
    `${import.meta.dir}/../openapi/specs/github.yaml`,
    // `${import.meta.dir}/gitea-spec.json`,
    'http://localhost:8787/github',
  );
  const api2 = await parseOpenAPISpec(
    `${import.meta.dir}/../openapi/specs/gitlab.yaml`,
    // `${import.meta.dir}/github-spec.yml`,
    'http://localhost:8787/gitlab',
  );

  const endpointMappings = await generateEndpointMappings(api1, api2);
  console.log(endpointMappings);
  const mappings: Mapping[] = [];
  for (const category of Object.keys(endpointMappings)) {
    const mapping = endpointMappings[category];
    const fieldMappings = await getFieldMappings(api1, api2, mapping);
    mappings.push({
      id: crypto.randomUUID(),
      name: category,
      parts: [
        getMappingPart(api1, mapping.api1, fieldMappings.api1),
        getMappingPart(api2, mapping.api2, fieldMappings.api2),
      ],
    });
  }

  while (true) {
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
}

main();

// ############ helper functions ################

function getMappingPart(
  api: Api,
  mapping: EndpointMappings[string]['api1'],
  fieldMapping: MappingPart['fieldMapping'],
): MappingPart {
  return {
    api,
    getAll: getEndpoint(api, mapping.getAll),
    getOne: getEndpoint(api, mapping.getOne),
    create: getEndpoint(api, mapping.create),
    update: getEndpoint(api, mapping.update),
    delete: getEndpoint(api, mapping.delete),
    fieldMapping,
  };
}
