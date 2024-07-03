import { parseOpenAPISpec } from './api';
import { generateMapping } from './generate_mapping';

async function main() {
  const githubApi = parseOpenAPISpec('../openapi/specs/github.yaml', 'http://localhost:8787/github');
  const gitlabApi = parseOpenAPISpec('../openapi/specs/gitlab.yaml', 'http://localhost:8787/gitlab');
  const mapping = await generateMapping(); // githubApi, gitlabApi);
  console.log(mapping);
  setInterval(() => { 
    // sync the data
    // 1. fetch endpoint from source
    // 2. map properties
    // 3. execute endpoint at target
  }, 1000);
}

main();