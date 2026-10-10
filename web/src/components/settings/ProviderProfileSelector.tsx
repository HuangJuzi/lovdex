import type { ProviderProfile } from './providerProfiles';

type Props = {
  profiles: Record<string, ProviderProfile>;
  selectedId: string;
  /** 表单值与该档已有差别 —— 下拉里给它加个「（已修改）」后缀。 */
  modified: boolean;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: () => void;
  onDelete: () => void;
};

const BTN =
  'h-8 flex-shrink-0 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50';

/** 配置档下拉 + 三个管理按钮。纯展示：状态都在 ProviderSettingsForm 里。 */
export function ProviderProfileSelector({
  profiles,
  selectedId,
  modified,
  disabled = false,
  onSelect,
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
