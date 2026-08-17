# 按钮统一 · W4 立体厚板(Chunky 3D)设计文档

日期:2026-08-13
状态:待审阅

## 背景

App 六个高频按钮(`新建任务 / 终端 / 返回任务面板 / 返回主页 / 查看任务 / 转为任务`)目前风格、尺寸混用(h-8 与 h-9 并存,返回按钮自带蓝/琥珀色覆写,新建任务是实心主色),用户要求统一。经多轮 HTML mockup 对比,选中 **W4 · 立体厚板(Chunky 3D)**,整体保持白色调。

## 视觉方案(W4)

- **统一尺寸基线**:高 34px、文字 14px、图标 16px、圆角 12px。
- **次要按钮**(返回/主页/查看/转为/终端):白卡渐变 `linear-gradient(180deg,#fff,#f3f1f6)`,细边框 `rgba(30,27,50,.08)`,4px 实体底边 `#d8d5df`,hover 浮起 +2px 且底边变 6px,按下下沉 +3px 且底边收至 1px。
- **主色按钮**(新建任务、终端激活态):蓝渐变 `linear-gradient(180deg,#5b8cff,#2f5fe0)`,白字,4px 深蓝底边 `#1c3fa8`,同样的浮起/下沉交互。
- **侧栏鉴权行**:Change Password 与 Sign Out 改为并排一行(各占 flex-1),同为次要厚板样式。

## 落地改动

### 1. 共享组件 `shared/view/ui/Button.tsx`

新增两个 variant、一个 size,不动现有 variant:

- `variant="chunky"` — 次要厚板(白卡)
- `variant="chunkyPrimary"` — 主色厚板(蓝渐变)
- `size="toolbar"` — `h-[34px] px-3.5 text-sm`;圆角 12px(`rounded-xl`,覆盖基础 rounded-md)

样式要点:`hover:-translate-y-0.5` + 底边加粗,`active:translate-y-[3px]` + 底边收窄;`transition` 覆盖 transform/box-shadow。

### 2. 六个按钮逐个收敛

| 位置 | 文件 | 改动 |
|---|---|---|
| 新建任务 | `components/tasks/TaskBoard.tsx` | 改用 `variant="chunkyPrimary" size="toolbar"`,文字「＋」换成 `Plus` 图标 |
| 终端 | `components/terminal/TerminalToggleButton.tsx` | 改用共享 Button;`open` 时 `chunkyPrimary`,否则 `chunky`;保留 Ctrl+` 提示与 `aria-pressed` |
| 返回任务面板 | `components/tasks/TaskBackNav.tsx` | 去掉蓝色覆写,改 `variant="chunky" size="toolbar"`,保留 ArrowLeft |
| 返回主页 | `components/tasks/TaskBackNav.tsx` | 去掉琥珀色覆写,改 `variant="chunky" size="toolbar"`,保留 Home |
| 查看任务 | `components/main-content/view/MainContent.tsx` | 手写 `<button>` 改共享 Button `chunky/toolbar`,补 `Eye` 图标 + 状态点 |
| 转为任务 | `components/main-content/view/MainContent.tsx` | 手写 `<button>` 改共享 Button `chunky/toolbar`,补 `RefreshCw` 图标 |
| 错误页返回 | `components/operators/AssistantPanel.tsx` | 手写按钮改 `variant="chunky" size="sm"` |

### 3. 侧栏鉴权行 `components/sidebar/view/subcomponents/SidebarFooter.tsx`

当前两个竖排整宽 `<button>`(`px-2 pb-1` / `px-2 pb-2`)合并为一个 `flex` 行:

```
<div class="flex gap-1.5 px-2 pb-2">
  <Button variant="chunky" size="sm" class="flex-1">…Change Password…</Button>
  <Button variant="chunky" size="sm" class="flex-1">…Sign Out…</Button>
</div>
```

保留 KeyRound / LogOut 图标与 i18n 文案;文字过长时截断(`truncate`)。

## 不改动

- 各 Dialog 内已有按钮(取消/创建/更新等)维持现状 —— 它们用默认 variant,不属于本次六个按钮范围。
- 图标集维持 lucide 线性风格;`Button` 基础类 `[&_svg]:size-4` 使图标统一 16px。

## 测试

- `TerminalToggleButton.test.tsx` 只断言渲染含「终端」,不受影响。
- 改动后跑 `lovdex-cli` 侧 `npm test`,并人工核对六个按钮在浅色/深色下 hover/active 状态(深色下白卡将整体换深,深色适配在实现时用 `dark:` 前缀补一组)。
