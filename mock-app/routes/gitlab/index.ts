import { Hono } from 'hono';

const gitlab = new Hono();

gitlab.get('/', (c) => {
  return c.text('Hello from Gitlab!');
});

export default gitlab;
