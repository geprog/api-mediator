import type { Api, Endpoint } from './types';

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
