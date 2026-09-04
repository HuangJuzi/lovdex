import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { GitStatusResponse } from '../types/types';
import type { Project } from '../../../types/app';

export type CurrentBranchInfo = {
  branch: string;
  notGitRepository: boolean;
};

/**
 * Lightweight git status probe used by the workspace nav to label the Source
 * Control tab with the checked-out branch (or a "not a git repository" hint),
 * without pulling in the full GitPanel controller. Reads the same
 * `/api/git/status` endpoint and `project` param the panel already uses, so the
 * tab label tracks whatever the panel would show for a given project.
 */
export function useCurrentBranch(selectedProject: Project | null): CurrentBranchInfo {
  const [branch, setBranch] = useState('');
  const [notGitRepository, setNotGitRepository] = useState(false);

  const projectId = selectedProject?.projectId ?? null;

  useEffect(() => {
    if (!projectId) {
      setBranch('');
      setNotGitRepository(false);
      return;
    }

    let cancelled = false;
    // Reset immediately so switching projects never leaks the previous branch.
    setBranch('');
    setNotGitRepository(false);

    void (async () => {
      try {
        const response = await authenticatedFetch(
          `/api/git/status?project=${encodeURIComponent(projectId)}`,
        );
        const data = (await response.json()) as GitStatusResponse;
        if (cancelled) return;
        setBranch(typeof data.branch === 'string' ? data.branch : '');
        setNotGitRepository(Boolean(data.notGitRepository));
      } catch {
        if (!cancelled) {
          setBranch('');
          setNotGitRepository(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return { branch, notGitRepository };
}