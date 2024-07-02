/**
 * input: mapping file, source api, target api, source repository, target repository
 * output: migrated issues
 */

// GitLab Configuration
const GITLAB_BASE_URL = 'https://gitlab.com';
const GITLAB_PROJECT_ID = 'YOUR_GITLAB_PROJECT_ID';
const GITLAB_PRIVATE_TOKEN = 'YOUR_GITLAB_PRIVATE_TOKEN';

// GitHub Configuration
const GITHUB_BASE_URL = 'https://api.github.com';
const GITHUB_REPO_OWNER = 'YOUR_GITHUB_REPO_OWNER';
const GITHUB_REPO_NAME = 'YOUR_GITHUB_REPO_NAME';
const GITHUB_TOKEN = 'YOUR_GITHUB_TOKEN';

// Headers for authentication
const gitlabHeaders = {
    'Private-Token': GITLAB_PRIVATE_TOKEN
};

const githubHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json'
};

interface GitLabIssue {
    id: number;
    title: string;
    description: string | null;
    labels: { id: number; name: string }[];
    assignee: { id: number; username: string } | null;
    state: string;
    created_at: string;
    updated_at: string;
    due_date: string | null;
    web_url: string;
}

interface GitHubIssue {
    title: string;
    body: string;
    labels: string[];
    assignees: string[];
    state: string;
}

const getGitLabIssues = async (): Promise<GitLabIssue[]> => {
    const issues: GitLabIssue[] = [];
    let page = 1;
    while (true) {
        const response = await fetch(
            `${GITLAB_BASE_URL}/api/v4/projects/${GITLAB_PROJECT_ID}/issues?page=${page}`,
            { headers: gitlabHeaders }
        );
        if (!response.ok) {
            break;
        }
        const pageIssues: GitLabIssue[] = await response.json();
        if (pageIssues.length === 0) {
            break;
        }
        issues.push(...pageIssues);
        page += 1;
    }
    return issues;
};

const mapGitLabIssueToGitHubIssue = (gitlabIssue: GitLabIssue): GitHubIssue => {
    return {
        title: gitlabIssue.title,
        body: `${gitlabIssue.description ?? ''}\n\n[Originally posted on GitLab](${gitlabIssue.web_url})`,
        labels: gitlabIssue.labels.map(label => label.name),
        assignees: gitlabIssue.assignee ? [gitlabIssue.assignee.username] : [],
        state: gitlabIssue.state === 'opened' ? 'open' : 'closed'
    };
};

const createGitHubIssue = async (issue: GitHubIssue): Promise<void> => {
    const response = await fetch(
        `${GITHUB_BASE_URL}/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/issues`,
        {
            method: 'POST',
            headers: {
                ...githubHeaders,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(issue)
        }
    );
    if (!response.ok) {
        const errorData = await response.json();
        console.error(`Failed to create issue: ${issue.title}`, errorData);
    } else {
        const data = await response.json();
        console.log(`Successfully created issue: ${issue.title}`, data);
    }
};

const migrateIssues = async (): Promise<void> => {
    const gitlabIssues = await getGitLabIssues();
    for (const gitlabIssue of gitlabIssues) {
        const githubIssue = mapGitLabIssueToGitHubIssue(gitlabIssue);
        await createGitHubIssue(githubIssue);
    }
};

migrateIssues().catch(error => console.error('Error migrating issues:', error));
