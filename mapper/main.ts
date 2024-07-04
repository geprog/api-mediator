import { parseOpenAPISpec } from './api';
import sync from './sync';
import type { Mapping } from './types';

async function main() {
  const githubApi = await parseOpenAPISpec(
    `${import.meta.dir}/../openapi/specs/github.yaml`,
    'http://localhost:8787/github',
  );
  const gitlabApi = await parseOpenAPISpec(
    `${import.meta.dir}/../openapi/specs/gitlab.yaml`,
    'http://localhost:8787/gitlab',
  );

  // await generateMapping(); // githubApi, gitlabApi);
  const mapping: Mapping = {
    id: crypto.randomUUID(),
    name: 'issues',
    parts: [
      {
        api: githubApi,
        getAll: githubApi.endpoints.find(
          (ep) => ep.path === '/issue' && ep.method === 'get',
        ),
        create: githubApi.endpoints.find(
          (ep) => ep.path === '/issue' && ep.method === 'post',
        ),
        update: githubApi.endpoints.find(
          (ep) => ep.path === '/issue' && ep.method === 'put',
        ),
        fieldMapping: {
          id: 'id',
          name: 'title',
          body: 'description',
          closed: 'closed',
        },
      },
      {
        api: gitlabApi,
        getAll: gitlabApi.endpoints.find(
          (ep) => ep.path === '/issues' && ep.method === 'get',
        ),
        create: gitlabApi.endpoints.find(
          (ep) => ep.path === '/issues' && ep.method === 'post',
        ),
        update: gitlabApi.endpoints.find(
          (ep) => ep.path === '/issues' && ep.method === 'put',
        ),
        fieldMapping: {
          id: 'id',
          title: 'name',
          description: 'body',
          closed: 'closed',
        },
      },
    ],
  };

  while (true) {
    await sync(mapping, mapping.parts[0], mapping.parts[1]);
    await sync(mapping, mapping.parts[1], mapping.parts[0]);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

main();
