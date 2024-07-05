import type { Api, EndpointMappings, Mapping } from '~/server/utils/types';
import { FILES, loadData } from '~/server/utils/useFileStorage';

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    api1: string;
    api2: string;
    name: string;
    mapping: EndpointMappings[string];
  }>(event);
  const api1 = (await $fetch(`/api/api/${body.api1}`)) as Api;
  const api2 = (await $fetch(`/api/api/${body.api2}`)) as Api;
  const endpointMapping = body.mapping;

  const fieldMappings = await getFieldMappings(api1, api2, endpointMapping);
  const mapping: Mapping = {
    id: crypto.randomUUID(),
    name: body.name,
    parts: [
      getMappingPart(api1, endpointMapping.api1, fieldMappings.api1),
      getMappingPart(api2, endpointMapping.api2, fieldMappings.api2),
    ],
  };

  const mappings = await loadData<Api>(FILES.mappings);
  await setData(FILES.mappings, [...mappings, mapping]);
  return mapping;
});

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

// Define the fieldMappingPrompt function
function fieldMappingPrompt(
  endpoints1: Encoding[],
  endpoints2: Encoding[],
): string {
  return `given the endpoints with their request body and response schema of two apis.
  
  api1: 
  ${endpoints1.map((e) => JSON.stringify(e)).join('\n')} 
  
  api2:
  ${endpoints2.map((e) => JSON.stringify(e)).join('\n')}
  
  find a field mapping between api1 and api2 so that i can use this to transfer data from api1 to api2 in the following json format:
  {
    fieldOfApi1: mappedFieldOfApi2
  }

  only output mappings with fields that exist in the respective api
  fields for which no mapping is possible shall be mapped to undefined
  ensure all fields of api1 are mapped
  `;
}

async function getFieldMapping(endpoints1: Encoding[], endpoints2: Encoding[]) {
  const prompt = fieldMappingPrompt(endpoints1, endpoints2);
  const response = await sendPrompt(prompt);
  const fieldMapping: Record<string, string> = JSON.parse(
    response.choices[0].message.content || '{}',
  );
  return fieldMapping;
}

export async function getFieldMappings(
  api1: Api,
  api2: Api,
  mapping: EndpointMappings[string],
) {
  const endpoints1 = getEndpointEncoding(api1, mapping.api1);
  const endpoints2 = getEndpointEncoding(api2, mapping.api2);

  const fieldMapping1 = await getFieldMapping(endpoints1, endpoints2);
  console.log('field mapping 1', fieldMapping1);
  const fieldMapping2 = await getFieldMapping(endpoints2, endpoints1);
  console.log('field mapping 2', fieldMapping2);

  return {
    api1: fieldMapping1,
    api2: fieldMapping2,
  };
}

type Encoding = {
  endpoint: string;
  description: string | undefined;
  requestBody: any;
  responseSchema: any;
};

function getEndpointEncoding(
  api: Api,
  mapping: EndpointMappings[string]['api1'],
): Encoding[] {
  const methods = Object.keys(mapping) as unknown as (keyof typeof mapping)[];
  return methods
    .filter((key) => !!mapping[key])
    .map((endpointIdentifier): Encoding | undefined => {
      const endpoint = getEndpoint(api, mapping[endpointIdentifier]);
      if (!endpoint) {
        return undefined;
      }
      return {
        endpoint: endpointIdentifier,
        description: endpoint.description,
        requestBody: endpoint.requestBody
          ? JSON.parse(endpoint.requestBody)
          : undefined,
        responseSchema: endpoint.responseSchema
          ? JSON.parse(endpoint.responseSchema)
          : undefined,
      };
    })
    .filter((encoding): encoding is Encoding => encoding !== undefined);
}
