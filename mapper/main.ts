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
  const mapping = { sourceAPI: githubApi, targetAPI: gitlabApi, source: { name: 'github-get', path: 'http://localhost:8787/github/issue', method: 'GET' }, target: { name: 'gitlab-post', path: 'http://localhost:8787/gitlab/issues', method: 'POST' }, mapping: { id: 'id', name: 'title', body: 'description', closed: 'closed' } }

  setInterval(async () => {
    // sync the data
    const sourceEndpoint = mapping.source;
    const targetEndpoint = mapping.target;
    // 1. fetch endpoint from source
    const sourceResponse = await fetch(mapping.source.path, { method: mapping.source.method });
    const sourceItems = await sourceResponse.json() as Record<string, unknown>[];
    console.log(`sycing ${sourceItems.length} items`);

    // 2. map properties
    for (const sourceItem of sourceItems) {
      console.log('handling sourceItem ', sourceItem);
      const targetItem = Object.entries(mapping.mapping).reduce<Record<string, unknown>>((item, [sourceProp, targetProp]) => (
        { ...item, [targetProp]: sourceItem[sourceProp] }
      ), {})
      console.log('mapped to targetItem ', targetItem);

      // 3. execute endpoint at target
      const response = await fetch(mapping.target.path, { method: mapping.target.method, body: JSON.stringify(targetItem), headers: { "Content-Type": "application/json" } });
      console.log('saved item ', await response.json());
    }

    // const syncData = mapping.source.responseSchema.fields.map((field) => mapping.mapping[field.name]);

  }, 5000);
}

main();
