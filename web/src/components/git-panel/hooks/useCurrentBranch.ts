import { useEffect, useState } from 'react';

import { branchStore } from '../../../stores/branchStore';
import type { BranchSnapshot } from '../../../stores/branchStore';
import type { Project } from '../../../types/app';

export type CurrentBranchInfo = BranchSnapshot;

const UNKNOWN_BRANCH: CurrentBranchInfo = { branch: '', notGitRepository: false };

/**
 * Lightweight git status probe used by the workspace nav to label the Source
 * Control tab with the checked-out branch (or a "not a git repository" hint),
 * without pulling in the full GitPanel controller.
 *
 * Branches are switched outside this component tree — an external shell, the
 * embedded terminal, or a chat session running `git checkout` — so there is no
 * in-app mutation to trigger a refresh. The shared {@link branchStore} owns that
 * polling; this hook only subscribes to it, which also keeps every branch
 * consumer in the app reading the exact same value.
 */
export function useCurrentBranch(selectedProject: Project | null): CurrentBranchInfo {
  const [info, setInfo] = useState<CurrentBranchInfo>(UNKNOWN_BRANCH);

  const projectId = selectedProject?.projectId ?? null;

  useEffect(() => {
    if (!projectId) {
      setInfo(UNKNOWN_BRANCH);
      return;
    }

    // Reset immediately so switching projects never leaks the previous branch;
    // a cached snapshot for this project (if the store already knows one) paints
    // the label right away instead of waiting for the next probe.
    setInfo(branchStore.getSnapshot(projectId) ?? UNKNOWN_BRANCH);
    return branchStore.subscribe(projectId, setInfo);
  }, [projectId]);

  return info;
}
