import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

type Issue = {
  id: number;
  title: string;
  description: string;
  closed: boolean;
};

const gitlab = new Hono();
gitlab.get('/issues', async ({ json }) => {
  const response = await getGitlabIssues();
  return json(response);
});

gitlab.post('/issues', async ({ req, json }) => {
  const issue = await req.json();
  const issues = await getGitlabIssues();

  if (issues.findIndex(({ id }) => id === issue.id) !== -1) {
    console.log();
    throw new HTTPException();
  }
  updateGitlabIssues([...issues, issue]);

  return json(issue);
});

gitlab.put('/issues', async ({ req, notFound, json }) => {
  const issue = await req.json();
  const issues = await getGitlabIssues();

  const index = issues.findIndex(({ id }) => id === issue.id);

  if (index === -1) {
    return notFound();
  }
  await updateGitlabIssues([
    ...issues.slice(0, index),
    issue,
    ...issues.slice(index + 1),
  ]);

  const updatedIssues = await getGitlabIssues();

  return json(updatedIssues);
});

async function updateGitlabIssues(issues: Issue[]): Promise<void> {
  await Bun.write(await getFile(), JSON.stringify(issues, undefined, 2));
}

async function getGitlabIssues(): Promise<Issue[]> {
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

export default gitlab;
