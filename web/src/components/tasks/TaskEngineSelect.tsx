import type { TaskEngine } from '../../types/app';
import { ENGINE_NAMES, type EngineAvailability } from './useTaskEngineAvailability';

type TaskEngineSelectProps = {
  availability: EngineAvailability;
  value: TaskEngine | '';
  onChange: (engine: TaskEngine) => void;
  className?: string;
};

const DEFAULT_CLASS = 'h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground';

/** Engine dropdown for the task forms. Disabled while probing, on a remote
 *  host with no available engine (shows the hint), or for the assistant
 *  project (locks to Claude). */
export function TaskEngineSelect({ availability, value, onChange, className }: TaskEngineSelectProps) {
  const disabled =
    availability.status === 'loading' || availability.status === 'unavailable' || availability.status === 'assistant';

  return (
    <div className="flex flex-col gap-1">
      <select
        className={className ?? DEFAULT_CLASS}
        value={value}
        onChange={(e) => onChange(e.target.value as TaskEngine)}
        disabled={disabled}
      >
        {availability.status === 'assistant' || availability.status === 'loading' ? (
          <option value={availability.status === 'assistant' ? 'claude' : value}>
            {ENGINE_NAMES[availability.status === 'assistant' ? 'claude' : (value || 'claude')]}
          </option>
        ) : null}
        {availability.status === 'unavailable' ? <option value="">{availability.hint}</option> : null}
        {availability.status === 'ready'
          ? availability.options.map((engine) => (
              <option key={engine} value={engine}>
                {ENGINE_NAMES[engine]}
              </option>
            ))
          : null}
      </select>
      {availability.status === 'ready' && availability.hint ? (
        <p className="text-xs text-muted-foreground">{availability.hint}</p>
      ) : null}
    </div>
  );
}
