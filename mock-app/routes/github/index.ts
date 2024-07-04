import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const github = new Hono();
type GithubIssue = {
  id: number;
  name: string;
  body: string;
  closed: boolean;
};
github.get('/issue', async ({ json }) => {
  const response = await getGithubIssues();
  return json(response);
});

github.post('/issue', async ({ req, json }) => {
  const issue = await req.json();
  const issues = await getGithubIssues();

  // assign always fresh id
  issue.id = crypto.randomUUID();

  if (issues.findIndex(({ id }) => id === issue.id) !== -1) {
    throw new HTTPException(404, { message: 'id already occupied' });
  }
  await updateGithubIssues([...issues, issue]);
  return json(issue);
});

github.put('/issue', async ({ req, notFound, json }) => {
  const issue = await req.json();
  const issues = await getGithubIssues();

  const index = issues.findIndex(({ id }) => id === issue.id);

  if (index === -1) {
    throw new HTTPException(404, { message: 'not Found' });
  }
  await updateGithubIssues([
    ...issues.slice(0, index),
    issue,
    ...issues.slice(index + 1),
  ]);

  const updatedIssues = await getGithubIssues();

  return json(updatedIssues);
});

async function updateGithubIssues(issues: GithubIssue[]): Promise<void> {
  await Bun.write(await getFile(), JSON.stringify(issues, undefined, 2));
}

async function getGithubIssues(): Promise<GithubIssue[]> {
  const file = await getFile();
  const issues = await file.json();

  return issues;
}

async function getFile() {
  const file = Bun.file(`${import.meta.dir}/issues.json`);
  if (!(await file.exists())) {
    await Bun.write(file, '[]');
    return await getFile();
  }
  return file;
}

export default github;
