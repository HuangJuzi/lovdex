import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type TerminalDrawerContextValue = {
  /** The directory the terminal should open in (the current project path), if any. */
  cwd: string | null;
  /** remote_hosts id of the project the terminal belongs to (null = local). */
  hostId: string | null;
  /** display name of the remote host (null = local). */
  hostName: string | null;
  setCwd: (
    cwd: string | null,
    meta?: { hostId?: string | null; hostName?: string | null },
  ) => void;
};

const TerminalDrawerContext = createContext<TerminalDrawerContextValue | null>(null);

export function TerminalDrawerProvider({ children }: { children: ReactNode }) {
  const [cwd, setCwdState] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [hostName, setHostName] = useState<string | null>(null);
  const setCwd = useCallback(
    (next: string | null, meta?: { hostId?: string | null; hostName?: string | null }) => {
      setCwdState(next);
      setHostId(meta?.hostId ?? null);
      setHostName(meta?.hostName ?? null);
    },
    [],
  );

  const value = useMemo<TerminalDrawerContextValue>(
    () => ({ cwd, hostId, hostName, setCwd }),
    [cwd, hostId, hostName, setCwd],
  );
  return <TerminalDrawerContext.Provider value={value}>{children}</TerminalDrawerContext.Provider>;
}

export function useTerminalDrawer(): TerminalDrawerContextValue {
  const context = useContext(TerminalDrawerContext);
  if (!context) throw new Error('useTerminalDrawer must be used within TerminalDrawerProvider');
  return context;
}
