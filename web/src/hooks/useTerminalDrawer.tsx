import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type TerminalDrawerContextValue = {
  /** The directory the terminal should open in (the current project path), if any. */
  cwd: string | null;
  setCwd: (cwd: string | null) => void;
};

const TerminalDrawerContext = createContext<TerminalDrawerContextValue | null>(null);

export function TerminalDrawerProvider({ children }: { children: ReactNode }) {
  const [cwd, setCwdState] = useState<string | null>(null);
  const setCwd = useCallback((next: string | null) => setCwdState(next), []);

  const value = useMemo<TerminalDrawerContextValue>(() => ({ cwd, setCwd }), [cwd, setCwd]);
  return <TerminalDrawerContext.Provider value={value}>{children}</TerminalDrawerContext.Provider>;
}

export function useTerminalDrawer(): TerminalDrawerContextValue {
  const context = useContext(TerminalDrawerContext);
  if (!context) throw new Error('useTerminalDrawer must be used within TerminalDrawerProvider');
  return context;
}
