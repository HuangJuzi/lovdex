import type { ProviderProfile } from './providerProfiles';

type Props = {
  profiles: Record<string, ProviderProfile>;
  selectedId: string;
  /** 表单值与该档已有差别 —— 下拉里给它加个「（已修改）」后缀，并允许「保存到该档」。 */
  modified: boolean;
  disabled?: boolean;
  onSelect: (id: string) => void;
  /** 把当前生效字段重新快照进选中档（覆盖它的 values，档名与 id 不变）。 */
  onUpdate: () => void;
  onCreate: () => void;
  onRename: () => void;
  onDelete: () => void;
};

const BTN =
  'h-8 flex-shrink-0 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50';

/** 配置档下拉 + 四个操作按钮。纯展示：状态都在 ProviderSettingsForm 里。 */
export function ProviderProfileSelector({
  profiles,
  selectedId,
  modified,
  disabled = false,
  onSelect,
  onUpdate,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* label 包住 select 而不是并排的 span：这样下拉才有可访问名（无需 id，
          同一页四个 provider 各渲染一个也不会撞）。 */}
      <label className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">配置档</span>
        <select
          className="h-8 rounded-md border border-border bg-muted px-2 text-xs text-foreground"
          value={selectedId}
          disabled={disabled}
          onChange={(e) => onSelect(e.target.value)}
        >
          <option value="">自定义（不归属任何档）</option>
          {Object.entries(profiles).map(([id, profile]) => (
            <option key={id} value={id}>
              {profile.name}
              {id === selectedId && modified ? '（已修改）' : ''}
            </option>
          ))}
        </select>
      </label>
      {/* 只在「选了档且表单确实与它不同」时可点：与档一致时保存是空操作，
          而没选档时该走「存为新档」。 */}
      <button
        type="button"
        className={BTN}
        disabled={disabled || !selectedId || !modified}
        onClick={onUpdate}
        title={modified ? '用当前生效的配置覆盖这一档' : '表单与该档一致，无需保存'}
      >
        保存到该档
      </button>
      <button type="button" className={BTN} disabled={disabled} onClick={onCreate}>
        存为新档
      </button>
      <button
        type="button"
        className={BTN}
        disabled={disabled || !selectedId}
        onClick={onRename}
      >
        重命名
      </button>
      <button
        type="button"
        className={BTN}
        disabled={disabled || !selectedId}
        onClick={onDelete}
      >
        删除
      </button>
    </div>
  );
}
