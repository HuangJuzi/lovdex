// src/components/auth/LoginPage.tsx
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { LogIn } from 'lucide-react';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '../../shared/view/ui';
import { useAuth } from './AuthGate';

export default function LoginPage() {
  const { t } = useTranslation('auth');
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !code.trim()) {
      setError(t('login.errors.requiredFields'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), code.trim());
      // AuthGate flips to authenticated and unmounts this page.
    } catch (err) {
      // Network failures surface as TypeError from fetch; credential mismatches
      // surface as the sentinel Error thrown by AuthGate.login.
      setError(
        err instanceof TypeError
          ? t('login.errors.networkError')
          : t('login.errors.invalidCredentials')
      );
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('login.title')}</CardTitle>
          <CardDescription>{t('login.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="login-email" className="text-sm font-medium text-foreground">
                {t('login.email')}
              </label>
              <Input
                id="login-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t('login.placeholders.email')}
                autoComplete="email"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="login-code" className="text-sm font-medium text-foreground">
                {t('login.code')}
              </label>
              <Input
                id="login-code"
                type="password"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder={t('login.placeholders.code')}
                autoComplete="current-password"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={submitting}>
              <LogIn className="h-4 w-4" />
              {submitting ? t('login.loading') : t('login.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
