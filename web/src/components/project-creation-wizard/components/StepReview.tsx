import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { isSshGitUrl } from '../utils/pathUtils';
import type { WizardFormState } from '../types';

type StepReviewProps = {
  formState: WizardFormState;
  selectedTokenName: string | null;
  isCreating: boolean;
  cloneProgress: string;
};

export default function StepReview({
  formState,
  selectedTokenName,
  isCreating,
  cloneProgress,
}: StepReviewProps) {
  const { t } = useTranslation();

  const authenticationLabel = useMemo(() => {
    if (formState.tokenMode === 'stored' && formState.selectedGithubToken) {
      return `${t('projectWizard.step3.usingStoredToken')} ${selectedTokenName || 'Unknown'}`;
    }

    if (formState.tokenMode === 'new' && formState.newGithubToken.trim()) {
      return t('projectWizard.step3.usingProvidedToken');
    }

    if (isSshGitUrl(formState.githubUrl)) {
      return t('projectWizard.step3.sshKey', { defaultValue: 'SSH Key' });
    }

    return t('projectWizard.step3.noAuthentication');
  }, [formState, selectedTokenName, t]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted p-4">
        <h4 className="mb-3 text-sm font-semibold text-foreground">
          {t('projectWizard.step3.reviewConfig')}
        </h4>

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">
              {formState.remoteHostName ? '远程主机 / 路径' : t('projectWizard.step3.path')}
            </span>
            <span className="break-all font-mono text-xs text-foreground">
              {formState.remoteHostName
                ? `${formState.remoteHostName}:${formState.workspacePath}`
                : formState.workspacePath}
            </span>
          </div>

          {formState.githubUrl && (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {t('projectWizard.step3.cloneFrom')}
                </span>
                <span className="break-all font-mono text-xs text-foreground">
                  {formState.githubUrl}
                </span>
              </div>

              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {t('projectWizard.step3.authentication')}
                </span>
                <span className="text-xs text-foreground">{authenticationLabel}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-info/20 bg-info/10 p-4">
        {isCreating && cloneProgress ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-info">
              {t('projectWizard.step3.cloningRepository', { defaultValue: 'Cloning repository...' })}
            </p>
            <code className="block whitespace-pre-wrap break-all font-mono text-xs text-info">
              {cloneProgress}
            </code>
          </div>
        ) : (
          <p className="text-sm text-info">
            {formState.githubUrl
              ? t('projectWizard.step3.newWithClone')
              : t('projectWizard.step3.newEmpty')}
          </p>
        )}
      </div>
    </div>
  );
}
