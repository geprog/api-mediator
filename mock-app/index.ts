import { Hono } from 'hono';
import github from './routes/github';
import gitlab from './routes/gitlab';
import { serve } from 'bun';

const app = new Hono();

app.get('/', (c) => {
  return c.text('Hello World!')
});

app.route('/github', github);
app.route('/gitlab', gitlab);

serve({ fetch: app.fetch, port: 8787 });
