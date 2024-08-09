import type { Api } from '~/server/utils/types';
import { FILES, loadData } from '~/server/utils/useFileStorage';

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    api1: string;
    endpoints1: string[];
    api2: string;
    endpoints2: string[];
  }>(event);
  const api1 = (await $fetch(`/api/api/${body.api1}`)) as Api;
  const api2 = (await $fetch(`/api/api/${body.api2}`)) as Api;

  return await generateMappings(api1, body.endpoints1, api2, body.endpoints2);
});

function getEndpoints(api: Api, endpointIdentifiers: string[]): string[] {
  const endpoints: string[] = [];
  for (const endpoint of api.endpoints) {
    const endpointIdentifier = `${endpoint.method.toUpperCase()} ${endpoint.path}`;
    if (endpointIdentifiers.includes(endpointIdentifier)) {
      endpoints.push(`${endpointIdentifier} - ${endpoint.description}`);
    }
  }
  return endpoints;
}

function endpointMappingPrompt(endpoints1: string[], endpoints2: string[]) {
  return `given api1 endpoints: ${endpoints1} and api2 endpoints: ${endpoints2} find a mapping between api1 endpoints and api2 endpoints in the following json format:
    {
      entity: {
        api1: {
          getAll: 'METHOD PATH',
          getOne: 'METHOD PATH',
          create: 'METHOD PATH',
          update: 'METHOD PATH',
          delete: 'METHOD PATH',
        },
        api2: {
          getAll: 'METHOD PATH',
          getOne: 'METHOD PATH',
          create: 'METHOD PATH',
          update: 'METHOD PATH',
          delete: 'METHOD PATH',
        }
      }
    }
    only output mappings with endpoints that exist in the respective api
    a useful mapping includes at least getAll or getOne and at least create or update
    use an empty string for endpoints that not exist in the api
    replace the field name entity by a proper keyword of the exchanged data
    ensure api1 and api2 are really the field names
    ensure getAll, getOne, create, update and delete are really the field names
    `;
}

async function generateMappings(
  api1: Api,
  endpoints1: string[],
  api2: Api,
  endpoints2: string[],
) {
  const api1Endpoints = getEndpoints(api1, endpoints1);
  const api2Endpoints = getEndpoints(api2, endpoints2);

  const response = await sendPrompt(
    endpointMappingPrompt(api1Endpoints, api2Endpoints),
  );

  // parse the response and filter for existing paths
  const mappings: EndpointMappings = JSON.parse(
    response.choices[0].message.content || '{}',
  );

  return mappings;
}
