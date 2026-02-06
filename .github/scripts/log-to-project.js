/**
 * Log PR to GitHub Project "Efforts"
 * This script uses GraphQL API to add PRs to the organization project
 * It expects github, context, and core to be available in the global scope
 */

/**
 * Find project by name in organization
 */
async function findProject(orgLogin, projectName) {
  console.log(`Searching for project "${projectName}" in organization "${orgLogin}"...`);
  
  const findProjectQuery = `
    query($orgLogin: String!) {
      organization(login: $orgLogin) {
        projectsV2(first: 50) {
          nodes {
            id
            title
            number
            closed
          }
        }
      }
    }
  `;
  
  let findProjectResult;
  try {
    findProjectResult = await github.graphql(findProjectQuery, { orgLogin });
  } catch (error) {
    console.error(`GraphQL error when querying organization: ${error.message}`);
    if (error.message.includes('Must have admin rights') || error.message.includes('permission')) {
      throw new Error(`\n❌ PERMISSION DENIED: The token does not have access to organization "${orgLogin}" projects.\n\n` +
        `To fix this:\n` +
        `1. Create a Personal Access Token (PAT) with 'project' scope\n` +
        `2. Go to: https://github.com/settings/tokens\n` +
        `3. Generate token (classic) with 'project' scope\n` +
        `4. Add it as repository secret: PROJECT_ACCESS_TOKEN\n` +
        `5. The workflow will automatically use PROJECT_ACCESS_TOKEN if available`);
    }
    throw error;
  }
  
  if (!findProjectResult.organization) {
    throw new Error(`Cannot access organization "${orgLogin}". The token may not have access to organization projects. Use a PAT with 'project' scope stored as PROJECT_ACCESS_TOKEN secret.`);
  }
  
  const projects = findProjectResult.organization?.projectsV2?.nodes || [];
  console.log(`Found ${projects.length} projects in organization "${orgLogin}"`);
  
  if (projects.length === 0) {
    throw new Error(`\n❌ No projects found in organization "${orgLogin}".\n\n` +
      `Possible reasons:\n` +
      `1. Token doesn't have permissions (most likely - use PAT with 'project' scope)\n` +
      `2. The project doesn't exist\n` +
      `3. The project is archived\n\n` +
      `Solution: Create a PAT with 'project' scope and add it as PROJECT_ACCESS_TOKEN secret.`);
  }
  
  console.log(`Available projects: ${projects.map(p => `"${p.title}" (closed: ${p.closed})`).join(', ')}`);
  
  // Try exact match first
  let project = projects.find(p => p.title === projectName);
  
  // Try case-insensitive match
  if (!project) {
    project = projects.find(p => p.title.toLowerCase() === projectName.toLowerCase());
  }
  
  // Try partial match
  if (!project) {
    project = projects.find(p => p.title.toLowerCase().includes(projectName.toLowerCase()));
  }
  
  if (!project) {
    const availableProjects = projects.map(p => p.title).join(', ');
    throw new Error(`Project "${projectName}" not found in organization "${orgLogin}". Available projects: ${availableProjects}`);
  }
  
  if (project.closed) {
    console.log(`Warning: Project "${projectName}" is closed/archived`);
  }
  
  console.log(`Found project: ${project.title} (ID: ${project.id})`);
  return project;
}

/**
 * Get project fields and find specific ones (effort, status, assignee)
 */
async function getProjectFields(projectId, prAuthor) {
  const getProjectFieldsQuery = `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 30) {
            nodes {
              ... on ProjectV2Field {
                id
                name
                dataType
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                dataType
                options {
                  id
                  name
                }
              }
              ... on ProjectV2IterationField {
                id
                name
                dataType
              }
            }
          }
        }
      }
    }
  `;
  
  const fieldsResult = await github.graphql(getProjectFieldsQuery, { projectId });
  const fields = fieldsResult.node?.fields?.nodes || [];
  console.log(`Project fields: ${fields.map(f => `${f.name} (${f.dataType})`).join(', ')}`);
  
  // Find specific fields
  const effortField = fields.find(f => f.name.toLowerCase() === 'effort');
  const weightField = fields.find(f => f.name.toLowerCase() === 'weight');
  const repoNameField = fields.find(f => f.name.toLowerCase() === 'reponame');
  const statusField = fields.find(f => f.name.toLowerCase() === 'status');
  const assigneeField = fields.find(f => f.name.toLowerCase() === 'assignees');
  
  // Find "Done" option in status field
  let doneOptionId = null;
  if (statusField && statusField.options) {
    const doneOption = statusField.options.find(opt => 
      opt.name.toLowerCase() === 'done' || 
      opt.name.toLowerCase() === 'completed' ||
      opt.name.toLowerCase() === 'closed'
    );
    if (doneOption) {
      doneOptionId = doneOption.id;
      console.log(`Found status "Done" option: ${doneOption.name} (ID: ${doneOptionId})`);
    }
  }
  
  // Get user ID for assignee
  let assigneeUserId = null;
  if (assigneeField) {
    try {
      const getUserQuery = `
        query($username: String!) {
          user(login: $username) {
            id
          }
        }
      `;
      const userResult = await github.graphql(getUserQuery, { username: prAuthor });
      assigneeUserId = userResult.user?.id;
      if (assigneeUserId) {
        console.log(`Found assignee user ID: ${assigneeUserId}`);
      }
    } catch (error) {
      console.log(`Could not get user ID for assignee: ${error.message}`);
    }
  }
  
  return {
    effortField,
    weightField,
    repoNameField,
    statusField,
    assigneeField,
    doneOptionId,
    assigneeUserId
  };
}

/**
 * Find existing issue in project for the given PR number and repository
 */
async function findExistingIssueInProject(projectId, prNumber, repository) {
  console.log(`Checking project items for existing issue for PR #${prNumber} in repository ${repository}...`);
  
  const getProjectItemsQuery = `
    query($projectId: ID!, $cursor: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              content {
                ... on Issue {
                  id
                  number
                  title
                  body
                }
              }
            }
          }
        }
      }
    }
  `;
  
  try {
    let allItems = [];
    let cursor = null;
    let hasNextPage = true;
    
    // Paginate through all items
    while (hasNextPage) {
      const projectItemsResult = await github.graphql(getProjectItemsQuery, { 
        projectId,
        cursor
      });
      
      const itemsData = projectItemsResult.node?.items || {};
      const items = itemsData.nodes || [];
      allItems = allItems.concat(items);
      
      hasNextPage = itemsData.pageInfo?.hasNextPage || false;
      cursor = itemsData.pageInfo?.endCursor;
      
      console.log(`Fetched ${items.length} items (total so far: ${allItems.length})`);
      
      // Check items as we fetch them to exit early if found
      for (const item of items) {
        if (item.content && item.content.title) {
          const titleMatch = item.content.title.match(/^PR #(\d+):/);
          if (titleMatch && parseInt(titleMatch[1]) === prNumber) {
            // Also check repository name in the issue body
            // Repository is stored as "**Repository:** <repo-name>" in the body
            const body = item.content.body || '';
            const repoMatch = body.match(/\*\*Repository:\*\* (.+)/);
            const issueRepo = repoMatch ? repoMatch[1].trim() : null;
            
            // Match if PR number matches AND repository matches
            // If repository is not found in body (old issue format), skip it to avoid false matches
            // This ensures we only match PRs from the correct repository
            if (issueRepo === repository) {
              console.log(`Found existing issue #${item.content.number} in project for PR #${prNumber} in repository ${repository}`);
              return {
                issue: item.content,
                itemId: item.id
              };
            } else if (issueRepo !== null) {
              console.log(`Found PR #${prNumber} but repository mismatch: expected ${repository}, found ${issueRepo} - skipping`);
            } else {
              console.log(`Found PR #${prNumber} but repository field not found in issue body - skipping to avoid cross-repo conflicts`);
            }
          }
        }
      }
    }
    
    console.log(`Checked all ${allItems.length} items in project`);
  } catch (error) {
    console.log(`Could not check project items: ${error.message}`);
  }
  
  return null;
}

/**
 * Create issue body text
 */
function createIssueBody(prNumber, prUrl, repository, prAuthor, stats, effort, weight) {
  return `**PR:** #${prNumber}
**PR Link:** ${prUrl}

**Repository:** ${repository}
**Author:** @${prAuthor}

**Stats:**
- Files Changed: ${stats.filesChanged}
- Additions: +${stats.additions}
- Deletions: -${stats.deletions}
- Total Changes: ${stats.totalChanges}
- **Weight: ${weight}**
- **Effort: ${effort}**`;
}

/**
 * Find or create issue for PR
 */
async function findOrCreateIssue(orgLogin, repository, prNumber, prTitle, prUrl, prAuthor, stats, effort, weight, projectId) {
  // First check if issue exists in project
  const projectIssue = await findExistingIssueInProject(projectId, prNumber, repository);
  
  if (projectIssue) {
    const issueBody = createIssueBody(prNumber, prUrl, repository, prAuthor, stats, effort, weight);
    const newTitle = `PR #${prNumber}: ${prTitle}`;
    
    await github.rest.issues.update({
      owner: orgLogin,
      repo: repository,
      issue_number: projectIssue.issue.number,
      title: newTitle,
      body: issueBody,
      assignees: [prAuthor]
    });
    
    console.log(`Updated existing issue #${projectIssue.issue.number} - title: "${newTitle}"`);
    return {
      issueId: projectIssue.issue.id,
      issueNumber: projectIssue.issue.number,
      itemId: projectIssue.itemId,
      isNew: false
    };
  }
  
  // Check if issue exists in repo but not in project
  console.log(`Searching repository for existing issue for PR #${prNumber}...`);
  const searchQuery = `repo:${orgLogin}/${repository} is:issue "PR #${prNumber}:" in:title`;
  const searchResult = await github.rest.search.issuesAndPullRequests({ q: searchQuery });
  
  if (searchResult.data.items && searchResult.data.items.length > 0) {
    const repoIssue = searchResult.data.items[0];
    const issueBody = createIssueBody(prNumber, prUrl, repository, prAuthor, stats, effort, weight);
    const newTitle = `PR #${prNumber}: ${prTitle}`;
    
    await github.rest.issues.update({
      owner: orgLogin,
      repo: repository,
      issue_number: repoIssue.number,
      title: newTitle,
      body: issueBody,
      assignees: [prAuthor]
    });
    
    console.log(`Updated existing issue #${repoIssue.number} in repository - title: "${newTitle}"`);
    return {
      issueId: repoIssue.node_id,
      issueNumber: repoIssue.number,
      itemId: null,
      isNew: false
    };
  }
  
  // Create new issue
  const issueBody = createIssueBody(prNumber, prUrl, repository, prAuthor, stats, effort, weight);
  console.log(`Creating new issue for PR #${prNumber}...`);
  
  const createIssueResult = await github.rest.issues.create({
    owner: orgLogin,
    repo: repository,
    title: `PR #${prNumber}: ${prTitle}`,
    body: issueBody,
    assignees: [prAuthor]
  });
  
  console.log(`Created new issue #${createIssueResult.data.number} (ID: ${createIssueResult.data.node_id})`);
  return {
    issueId: createIssueResult.data.node_id,
    issueNumber: createIssueResult.data.number,
    itemId: null,
    isNew: true
  };
}

/**
 * Add issue to project if not already there
 */
async function addIssueToProject(projectId, issueId, existingItemId) {
  if (existingItemId) {
    console.log(`Issue already in project, using existing item: ${existingItemId}`);
    return existingItemId;
  }
  
  const addItemMutation = `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: {
        projectId: $projectId
        contentId: $contentId
      }) {
        item {
          id
        }
      }
    }
  `;
  
  try {
    const addIssueResult = await github.graphql(addItemMutation, {
      projectId,
      contentId: issueId
    });
    const itemId = addIssueResult.addProjectV2ItemById?.item?.id;
    console.log(`Added issue to project: ${itemId}`);
    return itemId;
  } catch (addError) {
    console.log(`Could not add issue to project: ${addError.message}`);
    return null;
  }
}

/**
 * Update project item fields (effort, weight, reponame, status, assignee)
 */
async function updateProjectFields(projectId, itemId, issueNumber, orgLogin, repository, prAuthor, effort, weight, fields) {
  if (!itemId) return;
  
  const { effortField, weightField, repoNameField, statusField, assigneeField, doneOptionId, assigneeUserId } = fields;
  
  // Update effort field
  if (effortField) {
    const updateEffortMutation = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: {
            number: $value
          }
        }) {
          clientMutationId
        }
      }
    `;
    
    try {
      await github.graphql(updateEffortMutation, {
        projectId,
        itemId,
        fieldId: effortField.id,
        value: effort
      });
      console.log(`Updated effort field: ${effort}`);
    } catch (fieldError) {
      console.log(`Could not update effort field: ${fieldError.message}`);
    }
  }
  
  // Update weight field
  if (weightField) {
    const updateWeightMutation = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: {
            number: $value
          }
        }) {
          clientMutationId
        }
      }
    `;
    
    try {
      await github.graphql(updateWeightMutation, {
        projectId,
        itemId,
        fieldId: weightField.id,
        value: weight
      });
      console.log(`Updated weight field: ${weight}`);
    } catch (fieldError) {
      console.log(`Could not update weight field: ${fieldError.message}`);
    }
  }
  
  // Update repo name field
  if (repoNameField) {
    const updateRepoNameMutation = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: {
            text: $value
          }
        }) {
          clientMutationId
        }
      }
    `;
    
    try {
      await github.graphql(updateRepoNameMutation, {
        projectId,
        itemId,
        fieldId: repoNameField.id,
        value: repository
      });
      console.log(`Updated repo name field: ${repository}`);
    } catch (fieldError) {
      console.log(`Could not update repo name field: ${fieldError.message}`);
    }
  }
  
  // Update status to "Done"
  if (statusField && doneOptionId) {
    const updateStatusMutation = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: {
            singleSelectOptionId: $optionId
          }
        }) {
          clientMutationId
        }
      }
    `;
    
    try {
      await github.graphql(updateStatusMutation, {
        projectId,
        itemId,
        fieldId: statusField.id,
        optionId: doneOptionId
      });
      console.log(`Updated status to "Done"`);
    } catch (fieldError) {
      console.log(`Could not update status field: ${fieldError.message}`);
    }
  }
  
  // Update assignee
  if (assigneeField && assigneeUserId) {
    console.log(`Note: Assignee was set when creating the issue. Project assignee field may need manual configuration.`);
    
    try {
      await github.rest.issues.addAssignees({
        owner: orgLogin,
        repo: repository,
        issue_number: issueNumber,
        assignees: [prAuthor]
      });
      console.log(`Ensured assignee is set on issue: @${prAuthor}`);
    } catch (assigneeError) {
      console.log(`Could not update issue assignee: ${assigneeError.message}`);
    }
  }
}

/**
 * Main function
 */
(async () => {
  const orgLogin = context.repo.owner;
  const projectName = process.env.PROJECT_NAME || 'Efforts';
  const prNumber = context.payload.pull_request.number;
  const prId = context.payload.pull_request.node_id;
  const prUrl = context.payload.pull_request.html_url;
  const prTitle = context.payload.pull_request.title;
  const prAuthor = context.payload.pull_request.user.login;
  // Get repository name from PR payload (most reliable for PR events)
  // Falls back to context.repo.repo if payload is not available
  const repository = context.payload.pull_request?.base?.repo?.name || 
                     context.payload.repository?.name || 
                     context.repo.repo;
  
  // Read stats from file
  const fs = require('fs');
  const stats = JSON.parse(fs.readFileSync('pr_stats.json', 'utf8'));
  const effort = parseFloat(stats.effort.toFixed(2));
  const weight = parseFloat(stats.weight || process.env.WEIGHT || '1.0');
  
  console.log(`Logging PR #${prNumber} to project "${projectName}"...`);
  console.log(`Repository: ${repository}`);
  console.log(`Effort: ${effort}`);
  console.log(`Weight: ${weight}`);
  
  try {
    // Step 1: Find project
    const project = await findProject(orgLogin, projectName);
    
    // Step 2: Get project fields
    const fields = await getProjectFields(project.id, prAuthor);
    
    // Step 3: Find or create issue
    const issueInfo = await findOrCreateIssue(
      orgLogin,
      repository,
      prNumber,
      prTitle,
      prUrl,
      prAuthor,
      stats,
      effort,
      weight,
      project.id
    );
    
    // Step 4: Add issue to project
    const itemId = await addIssueToProject(project.id, issueInfo.issueId, issueInfo.itemId);
    
    // Step 5: Update project fields
    await updateProjectFields(
      project.id,
      itemId,
      issueInfo.issueNumber,
      orgLogin,
      repository,
      prAuthor,
      effort,
      weight,
      fields
    );
    
    console.log(`Successfully logged PR #${prNumber} to project "${projectName}"`);
    core.setOutput('project_item_id', itemId);
    core.setOutput('effort', effort.toString());
    core.setOutput('weight', weight.toString());
    core.setOutput('repository', repository);
    
  } catch (error) {
    console.error('Error logging to project:', error);
    console.log('Continuing workflow despite project logging error...');
  }
})().catch(error => {
  console.error('Error in project logging script:', error);
});

