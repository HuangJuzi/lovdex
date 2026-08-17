// src/components/auth/AuthGate.tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Loader2 } from 'lucide-react';

import { IS_PLATFORM } from '../../constants/config';
import { api } from '../../utils/api';
import LoginPage from './LoginPage';

const TOKEN_KEY = 'auth-token';

export type AuthUser = { id: number | string; username: string };

type AuthContextValue = {
  user: AuthUser | null;
  login: (email: string, code: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthGate');
  }
  return ctx;
};

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

/**
 * Login gate wrapping the app:
 * - Platform mode: always authenticated (it has its own auth flow).
 * - No stored token → login page.
 * - Stored token → validate via /api/auth/me; 401 clears it and shows login.
 * - Network error while validating → retry after 3s (don't log the user out).
 * Also listens for `auth:unauthorized` (dispatched by authenticatedFetch on any
 * 401) so a token that expires mid-session bounces back to the login page.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(
    IS_PLATFORM ? 'authenticated' : 'loading'
  );
  const [user, setUser] = useState<AuthUser | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);

  // Boot check: validate a stored token, or show the login page.
  useEffect(() => {
    if (IS_PLATFORM) {
      return;
    }
    let cancelled = false;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setStatus('unauthenticated');
      return;
    }
    setStatus('loading');
    api.auth
      .me()
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { user?: AuthUser };
          setUser(body.user ?? null);
          setStatus('authenticated');
        } else {
          localStorage.removeItem(TOKEN_KEY);
          setStatus('unauthenticated');
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Network failure — retry the boot check instead of logging out.
        setTimeout(() => {
          if (!cancelled) setBootAttempt((n) => n + 1);
        }, 3000);
      });
    return () => {
      cancelled = true;
    };
  }, [bootAttempt]);

  // Mid-session expiry: authenticatedFetch 401 → back to login page.
  useEffect(() => {
    if (IS_PLATFORM) return;
    const onUnauthorized = () => {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
      setStatus('unauthenticated');
    };
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(async (email: string, code: string) => {
    const res = await api.auth.login(email, code);
    if (!res.ok) {
      throw new Error('invalid-credentials');
    }
    const body = (await res.json()) as { token: string; user: AuthUser };
    localStorage.setItem(TOKEN_KEY, body.token);
    setUser(body.user);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, login, logout }),
    [user, login, logout]
  );

  return (
    <AuthContext.Provider value={value}>
      {status === 'unauthenticated' ? (
        <LoginPage />
      ) : status === 'loading' ? (
        <div className="flex min-h-screen items-center justify-center bg-background">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}
