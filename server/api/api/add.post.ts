import path from 'node:path';
import OpenAPIParser from '@readme/openapi-parser';
import type { OpenAPIV2, OpenAPIV3 } from 'openapi-types';
import type { Api } from '~/server/utils/types';
import { FILES, loadData } from '~/server/utils/useFileStorage';

export default defineEventHandler(async (event) => {
  const data = await readBody<{ baseUrl: string; openApiSpec: string }>(event);
  console.log(data);

  const apiId = crypto.randomUUID();

  const config = useRuntimeConfig();
  const localOpenApiSpecFile = path.join(
    config.dataPath,
    'openapi-specs',
    `${apiId}`,
  );
  await Bun.write(Bun.file(localOpenApiSpecFile), data.openApiSpec);
  const api = await parseOpenAPISpec(apiId, localOpenApiSpecFile, data.baseUrl);

  const apis = await loadData<Api>(FILES.apis);
  await setData(FILES.apis, [...apis, api]);
  return api;
});

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
  id: string,
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
      id,
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
