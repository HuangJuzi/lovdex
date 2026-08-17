import type { LLMProvider } from '../../types/app';
import ClaudeLogo from './ClaudeLogo';
import CodexLogo from './CodexLogo';
import OpenCodeLogo from './OpenCodeLogo';
import QoderLogo from './QoderLogo';

type SessionProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

export default function SessionProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: SessionProviderLogoProps) {
  if (provider === 'codex') {
    return <CodexLogo className={className} />;
  }

  if (provider === 'opencode') {
    return <OpenCodeLogo className={className} />;
  }

  if (provider === 'qoder') {
    return <QoderLogo className={className} />;
  }

  return <ClaudeLogo className={className} />;
}
