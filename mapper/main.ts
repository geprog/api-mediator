import { parseOpenAPISpec } from './api';
import { generateMapping } from './generate_mapping';

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
  const mapping = {
    sourceAPI: githubApi,
    targetAPI: gitlabApi,
    source: {
      name: 'github-get',
      path: '/issue',
      method: 'GET',
    },
    targetUpdate: {
      name: 'gitlab-post',
      path: '/issues',
      method: 'PUT',
    },
    targetSave: {
      name: 'gitlab-post',
      path: '/issues',
      method: 'POST',
    },
    mapping: {
      id: 'id',
      name: 'title',
      body: 'description',
      closed: 'closed',
    },
  };

  setInterval(async () => {
    // sync the data
    // 1. fetch endpoint from source
    const sourceResponse = await fetch(
      `${mapping.sourceAPI.baseUrl}${mapping.source.path}`,
      {
        method: mapping.source.method,
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
      const targetItem = Object.entries(mapping.mapping).reduce<
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
        `${mapping.targetAPI.baseUrl}${mapping.targetUpdate.path}`,
        {
          method: mapping.targetUpdate.method,
          body: JSON.stringify(targetItem),
          headers: { 'Content-Type': 'application/json' },
        },
      );
      
      // 3.2. save if not existing
      if (!updating.ok) {
        const response = await fetch(
          `${mapping.targetAPI.baseUrl}${mapping.targetSave.path}`,
          {
            method: mapping.targetSave.method,
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
