// src/components/tasks/SubStatusBadge.tsx
import type { SubStatus } from '../../types/app';
import { SUB_STATUS_META } from './taskStatus';

/**
 * Renders a sub-status tag (the card's bottom-left badge) from SUB_STATUS_META.
 * Null/unknown values render nothing so the component can be used defensively.
 */
export function SubStatusBadge({ subStatus }: { subStatus: SubStatus | null | undefined }) {
  if (!subStatus) return null;
  const meta = SUB_STATUS_META[subStatus];
  if (!meta) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold"
      style={{ color: meta.color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}
