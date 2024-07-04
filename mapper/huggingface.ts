import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL:
    'https://a7qhrth49u4ec0hi.eu-west-1.aws.endpoints.huggingface.cloud/v1/',
  apiKey: process.env['HUGGINGFACE_API_KEY'],
});

export async function sendPrompt(prompt: string) {
  const stream = await openai.chat.completions.create({
    model: 'tgi',
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    // stream: true,
    max_tokens: 20,
  });

  return stream;
}

// for await (const chunk of stream) {
//   process.stdout.write(chunk.choices[0]?.delta?.content || '');
// }
