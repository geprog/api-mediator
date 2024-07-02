import { Hono } from 'hono';

const github = new Hono();

github.get('/', (c) => {
  return c.text('Hello from Github!');
});

export default github;
