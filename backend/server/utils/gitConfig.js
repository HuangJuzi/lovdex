// Simplified edition: git panel/credentials removed. This stub keeps the
// /api/user/git-config route alive without depending on git tooling.
export async function getSystemGitConfig() {
  return { git_name: null, git_email: null };
}
