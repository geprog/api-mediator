import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const github = new Hono();
type GithubIssue =  {
  id: number;
  name: string;
  body: string;
  closed: boolean;
};
github.get('/issues', async ({ json }) => {
  const response = await getGithubIssues();
  return json(response);
});

github.post('/issues', async ({ req, notFound }) => {
  const issue = await req.json();
  const issues = await getGithubIssues();

  if (issues.findIndex(({ id }) => id === issue.id) !== -1) {
    throw new HTTPException(404, {message: 'not Found'});
  }
  updateGithubIssues([...issues, issue]);
  return issue;
});

github.put('/issues', async ({ req, notFound, json }) => {
  const issue = await req.json();
  const issues = await getGithubIssues();

  const index = issues.findIndex(({ id }) => id === issue.id);

  if (index === -1) {
    throw new HTTPException(404, {message: 'not Found'});
  }
  await updateGithubIssues([
    ...issues.slice(0, index),
    issue,
    ...issues.slice(index + 1),
  ]);

  const updatedIsuues = await getGithubIssues();

  return json(updatedIsuues);
});

async function updateGithubIssues(issues: GithubIssue[]): Promise<void> {
  await Bun.write(
    `${import.meta.dir}/issues.json`,
    JSON.stringify(issues, undefined, 2),
  );
}

async function getGithubIssues(): Promise<GithubIssue[]> {
  const file = Bun.file(`${import.meta.dir}/issues.json`);
  const issues = await file.json();

  return issues;
}

export default github;
