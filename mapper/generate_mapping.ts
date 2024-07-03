/**
 * input: 2 openapi files
 * output: mapping file
 */

// intermediate steps: try mapping, feed errors back to model and generate new mapping
import { openai, sendPrompt } from './openai';
import OpenAPIParser from '@readme/openapi-parser';
import { writeFileSync, readFileSync, existsSync } from 'fs';

// check if mapping-gitea-github.json exists
const MAPPING_FILE = 'mapping-gitea-github.json';

if (!existsSync(MAPPING_FILE)) {
  let giteaSpec;
  try {
    giteaSpec = await OpenAPIParser.parse('gitea-spec.json');
    console.log(
      'API name: %s, Version: %s',
      giteaSpec.info.title,
      giteaSpec.info.version,
    );
  } catch (err) {
    console.error(err);
  }
  let githubSpec;
  try {
    githubSpec = await OpenAPIParser.parse('github-spec.yml');
    console.log(
      'API name: %s, Version: %s',
      githubSpec.info.title,
      githubSpec.info.version,
    );
  } catch (err) {
    console.error(err);
  }

  // console.log(giteaSpec?.paths);
  // console.log(githubSpec?.paths);

  // load gitlab-spec.yml and github-spec.yml

  // const gitlabSpec = readFileSync('gitlab-spec.yml', 'utf-8');
  // const githubSpec = readFileSync('github-spec.yml', 'utf-8');

  // parse gitlab-spec.yml and github-spec.yml

  // import { parse, stringify } from 'yaml'

  // const gitlabApi = parse(gitlabSpec);
  // const githubApi = parse(githubSpec);

  // get all paths from gitlab and github

  const giteaEndpoints = [];
  const githubEndpoints = [];

  for (const path of Object.keys(giteaSpec?.paths || {})) {
    for (const method of Object.keys(giteaSpec?.paths[path])) {
      if (path.startsWith('/admin/')) {
        continue;
      }
      giteaEndpoints.push(`${method.toUpperCase()} ${path}`);
    }
  }
  console.log(giteaEndpoints);

  for (const path of Object.keys(githubSpec?.paths || {})) {
    for (const method of Object.keys(githubSpec?.paths[path])) {
      if (
        path.startsWith('/enterprises/') ||
        path.startsWith('/admin/') ||
        path.startsWith('/enterprise/')
      ) {
        continue;
      }
      githubEndpoints.push(`${method.toUpperCase()} ${path}`);
    }
  }
  console.log(githubEndpoints);

  type Mapping = {
    [key: string]: {
      gitea: {
        getAll: string;
        getOne: string;
        create: string;
        update: string;
        delete: string;
      };
      github: {
        getAll: string;
        getOne: string;
        create: string;
        update: string;
        delete: string;
      };
    };
  };

  /**
   * From two lists of strings, generate a mapping according to the prompt
   */
  async function getStringListMapping(
    list1: string[],
    list2: string[],
    prompt: (list1: string[], list2: string[]) => string,
  ) {
    const response = await sendPrompt(prompt(list1, list2));

    console.log(response.choices[0].message.content);

    // parse the response and filter for existing paths
    const mapping: Mapping = JSON.parse(response.choices[0].message.content);
    console.log(Object.keys(mapping).length, mapping);

    let filteredMapping: Mapping = {};
    let foundEndpoints1: string[] = [];
    let foundEndpoints2: string[] = [];
    for (const [entity, entityMapping] of Object.entries(mapping)) {
      let allEndpointsFound = true;
      let endpoints1: string[] = [];
      let endpoints2: string[] = [];
      for (const [method, path] of Object.entries(entityMapping.gitea)) {
        if (
          (path !== '' && !list1.includes(path)) ||
          (entityMapping.github[method] !== '' &&
            !list2.includes(entityMapping.github[method]))
        ) {
          allEndpointsFound = false;
          break;
        }
        endpoints1.push(path);
        endpoints2.push(entityMapping.github[method]);
      }
      if (allEndpointsFound) {
        filteredMapping[entity] = entityMapping;
        foundEndpoints1 = foundEndpoints1.concat(endpoints1);
        foundEndpoints2 = foundEndpoints2.concat(endpoints2);
      }
    }

    console.log(
      'mapping found',
      Object.keys(filteredMapping).length,
      filteredMapping,
      foundEndpoints1,
      foundEndpoints2,
    );
    if (Object.keys(filteredMapping).length > 0) {
      // remove already found paths from the lists
      list1 = list1.filter((path) => !foundEndpoints1.includes(path));
      list2 = list2.filter((path) => !foundEndpoints2.includes(path));
      const nextMapping = await getStringListMapping(list1, list2, prompt);
      filteredMapping = { ...filteredMapping, ...nextMapping };
    }
    return filteredMapping;
  }

  function similarStringsPrompt(list1: string[], list2: string[]) {
    return `given gitlab api paths: ${list1} and github api paths: ${list2} find similar paths between gitlab and github and generate a mapping in the following json format:
    {
      source: target,
    }
    `;
  }

  function downloadToUploadEndpointPrompt(list1: string[], list2: string[]) {
    return `given gitea api endpoints: ${list1} and github api endpoints: ${list2} find a mapping between gitea endpoints and github endpoints in the following json format:
    {
      entity: {
        gitea: {
          getAll: 'METHOD PATH',
          getOne: 'METHOD PATH',
          create: 'METHOD PATH',
          update: 'METHOD PATH',
          delete: 'METHOD PATH',
        },
        github: {
          getAll: 'METHOD PATH',
          getOne: 'METHOD PATH',
          create: 'METHOD PATH',
          update: 'METHOD PATH',
          delete: 'METHOD PATH',
        }
      }
    }
    only output mappings with endpoints that exist in the respective api
    a useful mapping includes at least getAll or getOne and at least create or update
    use an empty string for endpoints that not exist in the api
    `;
  }

  const mapping = await getStringListMapping(
    giteaEndpoints,
    githubEndpoints,
    downloadToUploadEndpointPrompt,
  );
  console.log('final mapping', mapping);

  // write mapping to file

  writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2));
} else {
  const mapping = JSON.parse(readFileSync(MAPPING_FILE, 'utf-8'));

  console.log(mapping);

  // TODO: filter irrelevant mappings
  // TODO: get schema mappings for relevant mappings
}

// const prompt = `generate a mapping from from gitlab issues to github issues in the following json format:

// type Endpoint = {
//     name: string;
//     description?: string;
//     path: string;
//     method: string;
// }

// {
//     source: Endpoint;
//     target: Endpoint;
//     mapping: Record<string, string>;
// }
// `;

// export async function generateMapping() {
//   const chatCompletion = await openai.chat.completions.create({
//     messages: [{ role: 'user', content: prompt }],
//     model: 'gpt-3.5-turbo',
//     response_format: { type: 'json_object' }
//   });
//   const mapping = JSON.parse(chatCompletion.choices[0].message.content || '{}') as Mapping;
//   return mapping;
// }
