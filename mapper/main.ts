import { parseOpenAPISpec } from './api';
import { generateMapping } from './generate_mapping';
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

  const {filteredMapping, fieldMapping} = await generateMapping(githubApi, gitlabApi); // githubApi, gitlabApi);
  console.log(filteredMapping, fieldMapping)
  const mapping: Mapping = {
    id: crypto.randomUUID(),
    name: 'issues',
    parts: [
      {
        api: githubApi,
        getAll: githubApi.endpoints.find(
          (ep) => `${ep.method.toUpperCase} ${ep.path}` === filteredMapping[0].github.getAll,
        ),
        create: githubApi.endpoints.find(
          (ep) => `${ep.method.toUpperCase} ${ep.path}` === filteredMapping[0].github.create,
        ),
        update: githubApi.endpoints.find(
          (ep) => `${ep.method.toUpperCase} ${ep.path}` === filteredMapping[0].github.update,
        ),
        fieldMapping
      },
      {
        api: gitlabApi,
        getAll: gitlabApi.endpoints.find(
          (ep) => `${ep.method.toUpperCase} ${ep.path}` === filteredMapping[0].gitea.getAll,
        ),
        create: gitlabApi.endpoints.find(
          (ep) => `${ep.method.toUpperCase} ${ep.path}` === filteredMapping[0].gitea.create,
        ),
        update: gitlabApi.endpoints.find(
          (ep) => `${ep.method.toUpperCase} ${ep.path}` === filteredMapping[0].gitea.update,
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
