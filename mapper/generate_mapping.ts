/**
 * input: 2 openapi files
 * output: mapping file
 */

// intermediate steps: try mapping, feed errors back to model and generate new mapping
import { openai, sendPrompt } from './openai';
import type { Mapping } from './types';


// load gitlab-spec.yml and github-spec.yml

import { readFileSync } from 'fs';

const gitlabSpec = readFileSync('gitlab-spec.yml', 'utf-8');
const githubSpec = readFileSync('github-spec.yml', 'utf-8');

// parse gitlab-spec.yml and github-spec.yml

import { parse, stringify } from 'yaml'

const gitlabApi = parse(gitlabSpec);
const githubApi = parse(githubSpec);

// get all paths from gitlab and github

const gitlabPaths = Object.keys(gitlabApi.paths);
const githubPaths = Object.keys(githubApi.paths);

console.log(gitlabPaths);
console.log(githubPaths);

const response = await sendPrompt(`given gitlab api paths: ${gitlabPaths} and github api paths: ${githubPaths} find similar paths between gitlab and github and generate a mapping in the following json format:
{
  source: target,
}
`);

console.log(response.choices[0].message.content);

// parse the response and filter for existing paths
// TODO


const prompt = `generate a mapping from from gitlab issues to github issues in the following json format:

type Endpoint = {  
    name: string;
    description?: string;
    path: string;
    method: string;
}

{
    source: Endpoint;
    target: Endpoint;
    mapping: Record<string, string>;
}
`;

export async function generateMapping() {
  const chatCompletion = await openai.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: 'gpt-3.5-turbo',
    response_format: { type: 'json_object' }
  });
  const mapping = JSON.parse(chatCompletion.choices[0].message.content || '{}') as Mapping;
  return mapping;
}
