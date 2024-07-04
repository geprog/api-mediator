import OpenAI from 'openai';

export const openai = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'], // This is the default and can be omitted
});

export async function sendPrompt(prompt: string) {
  return await openai.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
  });
}
