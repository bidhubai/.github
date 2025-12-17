/**
 * Get PR statistics using GitHub REST API
 * This script is designed to be used with actions/github-script@v7
 * It expects github, context, and core to be available in the global scope
 */

(async () => {
  const prNumber = context.payload.pull_request.number;
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  console.log(`Fetching PR files for PR #${prNumber}...`);

  // Fetch all PR files using pagination
  let allFiles = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await github.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      page,
      per_page: perPage
    });
    
    if (response.data.length === 0) break;
    
    allFiles = allFiles.concat(response.data);
    
    // If we got fewer than perPage, we're done
    if (response.data.length < perPage) break;
    
    page++;
  }

  console.log(`Found ${allFiles.length} files`);

  // Calculate statistics
  let filesChanged = allFiles.length;
  let additions = 0;
  let deletions = 0;
  let totalChanges = 0;

  // Build changed lines data structure (file -> array of line numbers)
  const changedLines = {};

  allFiles.forEach(file => {
    additions += file.additions || 0;
    deletions += file.deletions || 0;
    totalChanges += file.changes || 0;
    
    // For changed lines, we'd need to parse the patch, but for now
    // we'll just track which files changed
    if (file.status !== 'removed') {
      changedLines[file.filename] = [];
      // Note: To get actual line numbers, we'd need to parse file.patch
      // For now, we'll use the total changes as a proxy
    }
  });

  // Calculate work effort: sqrt(deletions * 0.2 + additions * 1.0)
  const lineScore = deletions * 0.2 + additions * 1.0
  const lineScoreUnit = 200
  const lineScoreUnitCount = Math.floor(lineScore / lineScoreUnit)
  const effort = lineScoreUnitCount * Math.sqrt(lineScoreUnit) + Math.sqrt(lineScore - lineScoreUnitCount * lineScoreUnit);

  const stats = {
    filesChanged,
    additions,
    deletions,
    totalChanges,
    effort,
    changedLines: JSON.stringify(changedLines),
    files: allFiles.map(f => f.filename)
  };

  console.log('=== PR Statistics ===');
  console.log(`Files changed: ${stats.filesChanged}`);
  console.log(`Additions: ${stats.additions}`);
  console.log(`Deletions: ${stats.deletions}`);
  console.log(`Total changes: ${stats.totalChanges}`);
  console.log(`Work effort: ${stats.effort.toFixed(2)}`);
  console.log('====================');

  // Set outputs
  core.setOutput('files_changed', stats.filesChanged.toString());
  core.setOutput('additions', stats.additions.toString());
  core.setOutput('deletions', stats.deletions.toString());
  core.setOutput('total_changes', stats.totalChanges.toString());
  core.setOutput('effort', stats.effort.toFixed(2));
  core.setOutput('changed_lines', stats.changedLines);
  core.setOutput('files', JSON.stringify(stats.files));

  // Write to file for use in next step
  const fs = require('fs');
  fs.writeFileSync('pr_stats.json', JSON.stringify(stats, null, 2));
})().catch(error => {
  console.error('Error fetching PR stats:', error);
  core.setFailed(error.message);
});

