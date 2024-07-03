import OpenAPIParser from '@readme/openapi-parser';
import type { Api, Endpoint } from './types';

export async function parseOpenAPISpec(
  apiSpecPath: string,
  baseUrl: string,
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
          const { operationId, description } = spec.get;
          endpoints.push({
            method: 'get',
            name: operationId || '',
            path,
            responseSchema: { name: '', fields: [] },
            description,
          });
        }
        if (!!spec.post) {
          const { operationId, description } = spec.post;
          endpoints.push({
            method: 'post',
            name: operationId || '',
            path,
            responseSchema: { name: '', fields: [] },
            description,
          });
        }
        if (!!spec.put) {
          const { operationId, description } = spec.put;
          endpoints.push({
            method: 'put',
            name: operationId || '',
            path,
            responseSchema: { name: '', fields: [] },
            description,
          });
        }
      }
    });

    const api: Api = {
      name: apiSpec.info.title,
      baseUrl,
      accessToken: '',
      endpoints,
      schemas: [],
    };
    return api;
  } catch (err) {
    console.error(err);
    throw err;
  }
}
