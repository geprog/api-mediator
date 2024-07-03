import { parseOpenAPISpec } from './api';
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
    name: 'issues',
    parts: [{
      api: githubApi,
      getAll: githubApi.endpoints.find((ep) => ep.path === '/issue' && ep.method === 'get'),
      create: githubApi.endpoints.find((ep) => ep.path === '/issue' && ep.method === 'post'),
      update: githubApi.endpoints.find((ep) => ep.path === '/issue' && ep.method === 'put'),
      fieldMapping: {
        id: 'id',
        name: 'title',
        body: 'description',
        closed: 'closed',
      },
    },
  {
    api: gitlabApi,
      getAll: gitlabApi.endpoints.find((ep) => ep.path === '/issues' && ep.method === 'get'),
      create: gitlabApi.endpoints.find((ep) => ep.path === '/issues' && ep.method === 'post'),
      update: gitlabApi.endpoints.find((ep) => ep.path === '/issues' && ep.method === 'put'),
      fieldMapping: {
        id: 'id',
        title: 'name',
        description: 'body',
        closed: 'closed',
      },
  }]
    
  };

  setInterval(async () => {
    // sync the data
    // 1. fetch endpoint from source
    if (!mapping.parts[0].getAll || !mapping.parts[1].create|| !mapping.parts[1].update) {
      return;
    }
    const sourceResponse = await fetch(
      `${mapping.parts[0].api.baseUrl}${mapping.parts[0].getAll.path}`,
      {
        method: mapping.parts[0].getAll.method,
      },
    );
    const sourceItems = (await sourceResponse.json()) as Record<
      string,
      unknown
    >[];
    console.log(`sycing ${sourceItems.length} items`);

    // 2. map properties
    for (const sourceItem of sourceItems) {
      console.log('handling sourceItem ', sourceItem);
      const targetItem = Object.entries(mapping.parts[0].fieldMapping).reduce<
        Record<string, unknown>
      >(
        (item, [sourceProp, targetProp]) => ({
          ...item,
          [targetProp]: sourceItem[sourceProp],
        }),
        {},
      );
      console.log('mapped to targetItem ', targetItem);

      // 3. execute endpoint at target
      // 3.1. try updating
      const updating = await fetch(
        `${mapping.parts[1].api.baseUrl}${mapping.parts[1].update.path}`,
        {
          method: mapping.parts[1].update.method,
          body: JSON.stringify(targetItem),
          headers: { 'Content-Type': 'application/json' },
        },
      );
      
      // 3.2. save if not existing
      if (!updating.ok) {
        const response = await fetch(
          `${mapping.parts[1].api.baseUrl}${mapping.parts[1].create.path}`,
          {
            method: mapping.parts[1].create.method,
            body: JSON.stringify(targetItem),
            headers: { 'Content-Type': 'application/json' },
          },
        );
        console.log('created new target item ', await response.json());
      } else {
        console.log('updated target item ', await updating.json());
      }
    }
  }, 5000);
}

main();
