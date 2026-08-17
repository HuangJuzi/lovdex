import spawn from 'cross-spawn';

function runGit(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', () => resolve({ ok: false, stdout, stderr }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

export async function isGitRepo(projectPath) {
  const { ok } = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
  return ok;
}

/** Most recent commit with date <= isoTimestamp, or null. */
export async function findCommitAtOrBefore(projectPath, isoTimestamp) {
  const { ok, stdout } = await runGit(projectPath, [
    'log', '-1', '--format=%H', `--before=${isoTimestamp}`,
  ]);
  if (!ok) return null;
  const hash = stdout.trim();
  return hash || null;
}

/** Best-effort: stash current changes, restore tracked files to `commit`. */
export async function rewindFilesToCommit(projectPath, commit) {
  await runGit(projectPath, ['stash', '--include-untracked', '-m', 'lovdex-rewind']);
  const res = await runGit(projectPath, ['checkout', commit, '--', '.']);
  return res.ok;
}
