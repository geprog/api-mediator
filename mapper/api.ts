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

function parseOperationObject(
  path: string,
  operationObject: OpenAPIV3.OperationObject | OpenAPIV2.OperationObject,
  method: string,
): Endpoint {
  const { operationId, parameters, description, summary } = operationObject;
  return {
    method,
    name: operationId || '',
    path,
    parameters: (parameters || [])
      .filter(isNotReferenceObject)
      .filter((param) => param.required && param.in === 'path')
      .map((param) => ({
        name: param.name,
        description: param.description,
      })),
    requestBody:
      'requestBody' in operationObject && operationObject.requestBody
        ? JSON.stringify(operationObject.requestBody)
        : '',
    responseSchema: JSON.stringify(operationObject.responses),
    description: summary || description,
  };
}

export async function parseOpenAPISpec(
  apiSpecPath: string,
  baseUrl: string,
  parameterSubstitutions: Api['parameterSubstitutions'] = [],
): Promise<Api> {
  try {
    let apiSpec = await OpenAPIParser.dereference(apiSpecPath);
    console.log(
      'Parsed openapi spec of API name: %s, Version: %s',
      apiSpec.info.title,
      apiSpec.info.version,
    );

    const specs = apiSpec.paths || {};

    const endpoints: Endpoint[] = [];

    Object.keys(specs).forEach((path) => {
      if (
        path.startsWith('/admin/') ||
        path.startsWith('/enterprises/') ||
        path.startsWith('/enterprise/') ||
        path.startsWith('/notifications/') ||
        path.startsWith('/labels/') ||
        path.startsWith('/gists/') ||
        path.startsWith('/orgs/')
      ) {
        return;
      }
      const spec = specs[path];
      if (typeof spec === 'object') {
        if (spec.get) {
          endpoints.push(parseOperationObject(path, spec.get, 'get'));
        }
        if (spec.post) {
          endpoints.push(parseOperationObject(path, spec.post, 'post'));
        }
        if (spec.put) {
          endpoints.push(parseOperationObject(path, spec.put, 'put'));
        }
        if (spec.patch) {
          endpoints.push(parseOperationObject(path, spec.patch, 'patch'));
        }
        if (spec.delete) {
          endpoints.push(parseOperationObject(path, spec.delete, 'delete'));
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

export function getEndpoint(
  api: Api,
  endpointIdentifier: string,
): Endpoint | undefined {
  return api.endpoints.find(
    (ep) => `${ep.method.toUpperCase()} ${ep.path}` === endpointIdentifier,
  );
}
