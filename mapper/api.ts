import OpenAPIParser from '@readme/openapi-parser';
import type { Api, Endpoint } from './types';

import { OpenAPIV3, OpenAPIV2 } from 'openapi-types';

function isNotReferenceObject(
  parameter:
    | OpenAPIV3.ReferenceObject
    | OpenAPIV3.ParameterObject
    | OpenAPIV2.Parameter,
): parameter is OpenAPIV3.ParameterObject {
  return !('$ref' in parameter);
}

export async function parseOpenAPISpec(
  apiSpecPath: string,
  baseUrl: string,
  parameterSubstitutions: Api['parameterSubstitutions'] = [],
): Promise<Api> {
  try {
    let apiSpec = await OpenAPIParser.validate(apiSpecPath);
    console.log(
      'Parsed openapi spec of API name: %s, Version: %s',
      apiSpec.info.title,
      apiSpec.info.version,
    );

    const specs = apiSpec.paths || {};

    const endpoints: Endpoint[] = [];

    Object.keys(specs).forEach((path) => {
      const spec = specs[path];
      if (typeof spec === 'object') {
        if (!!spec.get) {
          const { operationId, parameters, description } = spec.get;
          endpoints.push({
            method: 'get',
            name: operationId || '',
            path,
            parameters: (parameters || [])
              .filter(isNotReferenceObject)
              .filter((param) => param.required && param.in === 'path')
              .map((param) => ({
                name: param.name,
                description: param.description,
              })),
            responseSchema: { name: '', fields: [] },
            description,
          });
        }
        if (!!spec.post) {
          const { operationId, parameters, description } = spec.post;
          endpoints.push({
            method: 'post',
            name: operationId || '',
            path,
            parameters: (parameters || [])
              .filter(isNotReferenceObject)
              .filter((param) => param.required && param.in === 'path')
              .map((param) => ({
                name: param.name,
                description: param.description,
              })),
            responseSchema: { name: '', fields: [] },
            description,
          });
        }
        if (!!spec.put) {
          const { operationId, parameters, description } = spec.put;
          endpoints.push({
            method: 'put',
            name: operationId || '',
            path,
            parameters: (parameters || [])
              .filter(isNotReferenceObject)
              .filter((param) => param.required && param.in === 'path')
              .map((param) => ({
                name: param.name,
                description: param.description,
              })),
            responseSchema: { name: '', fields: [] },
            description,
          });
        }
      }
    });

    const api: Api = {
      id: crypto.randomUUID(),
      name: apiSpec.info.title,
      baseUrl,
      accessToken: '',
      parameterSubstitutions,
      endpoints,
      schemas: [],
      rawApiSpec: apiSpec,
    };
    return api;
  } catch (err) {
    console.error(err);
    throw err;
  }
}

export async function doFetch(
  api: Api,
  endpoint: Endpoint,
  parameterSubstitutions: Record<string, unknown>,
  body?: Record<string, unknown>,
) {
  const path = endpoint.parameters.reduce(
    (path, parameter) =>
      path.replace(
        `{${parameter.name}}`,
        `${parameterSubstitutions[parameter.name]}`,
      ),
    endpoint.path,
  );
  const response = await fetch(`${api.baseUrl}${path}`, {
    method: endpoint.method,
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
  });
  return await response.json();
}
