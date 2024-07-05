import type { OpenAPI } from 'openapi-types';
import type { Api, EndpointMappings } from './types';
import { getEndpoint } from './api';
import { sendPrompt } from './openai';

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
