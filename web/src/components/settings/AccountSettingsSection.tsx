import { LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../auth/AuthGate';
import { Button } from '../../shared/view/ui';

import ChangePasswordForm from './ChangePasswordForm';

/**
 * 账号 Tab：修改密码（内联表单）+ 登出。platform 模式下由 SettingsPage
 * 隐藏整个 Tab（无本地密码/登出）。
 */
export function AccountSettingsSection() {
  const { t } = useTranslation('auth');
  const { logout } = useAuth();

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold text-foreground">{t('changePassword.title')}</h2>
        <ChangePasswordForm />
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">{t('logout.title')}</h2>
        <p className="mb-3 text-xs text-muted-foreground">{t('logout.confirm')}</p>
        <Button variant="destructive" onClick={logout}>
          <LogOut className="mr-2 h-4 w-4" />
          {t('logout.button')}
        </Button>
      </section>
    </div>
  );
}
