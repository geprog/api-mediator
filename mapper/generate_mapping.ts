/**
 * input: 2 openapi files
 * output: mapping file
 */

// intermediate steps: try mapping, feed errors back to model and generate new mapping
import { openai } from './openai';
import type { Mapping } from './types';

const prompt = `Create a mapping between the apis of gitlab and github. It shall be in the following json format:

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