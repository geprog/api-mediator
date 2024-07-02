import { Hono } from 'hono';
import fs from 'fs';
const gitlab = new Hono();
gitlab.get('/issues', ({json}) => {
 const response = getGitlabIssues();
  return json(response);
});


 function getGitlabIssues(): string {
  const files = '';
  fs.readFile('./issues/gitlab/', (err, data) => files.concat(data.toString()));
  return files;
} 
export default gitlab;
