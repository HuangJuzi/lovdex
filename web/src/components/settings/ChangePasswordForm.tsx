import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../shared/view/ui';
import { api } from '../../utils/api';

/**
 * 修改密码内联表单（从 ChangePasswordDialog 迁入，去掉 Dialog 外框）。
 * 走 `POST /api/auth/change-password`（raw fetch，避免 401 触发全局登出）。
 */
export default function ChangePasswordForm() {
  const { t } = useTranslation('auth');
  const [currentCode, setCurrentCode] = useState('');
  const [newCode, setNewCode] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!currentCode.trim() || !newCode.trim() || !confirmCode.trim()) {
      setError(t('changePassword.errors.requiredFields'));
      return;
    }
    if (newCode !== confirmCode) {
      setError(t('changePassword.errors.mismatch'));
      return;
    }
    if (newCode.trim().length < 4) {
      setError(t('changePassword.errors.tooShort'));
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      const res = await api.auth.changePassword(currentCode, newCode);
      if (res.ok) {
        setSuccess(true);
        setCurrentCode('');
        setNewCode('');
        setConfirmCode('');
        closeTimerRef.current = setTimeout(() => {
          closeTimerRef.current = null;
          setSuccess(false);
          setSubmitting(false);
        }, 800);
      } else {
        setError(
          res.status === 401
            ? t('changePassword.errors.wrongCurrent')
            : res.status === 400
              ? t('changePassword.errors.invalidNew')
              : t('changePassword.errors.generic'),
        );
        setSubmitting(false);
      }
    } catch (err) {
      setError(
        err instanceof TypeError
          ? t('changePassword.errors.networkError')
          : t('changePassword.errors.generic'),
      );
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="cp-current" className="text-sm font-medium text-foreground">
          {t('changePassword.current')}
        </label>
        <Input
          id="cp-current"
          type="password"
          value={currentCode}
          onChange={(e) => setCurrentCode(e.target.value)}
          placeholder={t('changePassword.placeholders.current')}
          autoComplete="current-password"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="cp-new" className="text-sm font-medium text-foreground">
          {t('changePassword.new')}
        </label>
        <Input
          id="cp-new"
          type="password"
          value={newCode}
          onChange={(e) => setNewCode(e.target.value)}
          placeholder={t('changePassword.placeholders.new')}
          autoComplete="new-password"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="cp-confirm" className="text-sm font-medium text-foreground">
          {t('changePassword.confirm')}
        </label>
        <Input
          id="cp-confirm"
          type="password"
          value={confirmCode}
          onChange={(e) => setConfirmCode(e.target.value)}
          placeholder={t('changePassword.placeholders.confirm')}
          autoComplete="new-password"
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          {t('changePassword.success')}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="submit" disabled={submitting}>
          {submitting ? t('changePassword.loading') : t('changePassword.submit')}
        </Button>
      </div>
    </form>
  );
}
