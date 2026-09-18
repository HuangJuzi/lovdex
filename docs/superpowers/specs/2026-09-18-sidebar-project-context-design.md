# 侧栏项目归属感优化（多展开 + 粘性分组头）设计

日期：2026-09-18
状态：已确认，待写实现计划

## 0. 背景与目标

侧栏在项目和会话都变多之后，展开某个项目时会「不知道自己正在看哪个项目」。用户确认的痛点有三条：

1. **滚下去后项目名滚走了** —— 会话列表一长，项目行滚出视野，剩下满屏 session 没有任何归属线索。
2. **同时只能展开一个项目** —— `useSidebarController.ts:353-361` 的 `toggleProject` 每次构造一个只含目标 id 的新 `Set`，是刻意的手风琴；点开 B 会收起 A，切走再切回来要重新展开、重新找。
3. **缩进 / 竖线太弱** —— 会话区只有 `border-l border-border` 一条 1px 灰线（`SidebarProjectSessions.tsx:87`），从属关系在视觉上几乎读不出来。

本设计用三处改动一起解决，**不引入新的配色体系**（侧栏已有 primary / 绿=运行中 / 琥珀=待处理 / 靛=远程四套语义色，再加项目色会打架，暗色模式也要重调）：

| 痛点 | 手段 |
|---|---|
| 滚走了 | 项目头 `position: sticky` 吸顶，粘到本项目会话列表结束 |
| 只能开一个 | `toggleProject` 改成真正的增删，支持多展开 |
| 分组太弱 | 会话区升级为「导轨 + 淡底 + 圆角」的整块面板 |

另外补两个配套：**「全部收起」**（多展开后列表会变长，需要一键复位）和**展开时滚入视野**（点开了但看不见展开的内容）。

## 1. 状态层：多展开

**新增纯函数**到 `web/src/components/sidebar/utils/utils.ts`（该文件已是「排序 / 过滤 / 持久化 / ViewModel」的纯逻辑定位）：

```ts
/** 切换单个 Project 的展开态，返回新集合（不修改入参）。 */
export const toggleExpandedProject = (
  expanded: ReadonlySet<string>,
  projectId: string,
): Set<string> => {
  const next = new Set(expanded);
  if (next.has(projectId)) {
    next.delete(projectId);
  } else {
    next.add(projectId);
  }
  return next;
};
```

**改写** `useSidebarController.ts:353-361`：

```ts
const toggleProject = useCallback((projectId: string) => {
  setExpandedProjects((prev) => toggleExpandedProject(prev, projectId));
}, []);
```

**持久化不用动**：`utils.ts:39` 的 `writeStoredExpandedProjects` 本来就是 `JSON.stringify([...projectIds])`，`useSidebarController.ts:178` 的 effect 按 `expandedProjects` 变化触发，多元素集合天然支持。

**点击语义不变**：`SidebarProjectItem.tsx:145-151` 的 `selectAndToggleProject` 仍是「先选中、再切换展开」，点已展开的项目仍是收起。

## 2. 粘性项目头

### 2.1 必须先解决的结构问题

`SidebarProjectItem.tsx` 当前层级：

```
<div className="md:space-y-1">            ← :154，同时包含项目行和会话区
  <div className="md:group group">         ← :155，只包住项目行（移动卡片 + 桌面 Button）
    <div className="md:hidden">…</div>     ← :156
    <Button … />                           ← :318
  </div>
  <SidebarProjectSessions … />             ← :484，在 :155 的**外面**
</div>
```

`position: sticky` 只在**其包含块**（最近的块级祖先）范围内粘住。若把 sticky 加在项目行本身，包含块是 `:155` 的 div，而它只有项目行那么高 —— 粘一像素就会被推出包含块，等于失效。

**做法**：把 sticky 加在 `:155` 的 div 上。它的包含块是 `:154` 的 div，而这个 div 同时包含下面的 `SidebarProjectSessions`，因此项目头会一直粘到本项目会话列表结束，然后被下一个项目行顶走 —— 正是需要的行为。

**层级不能乱动**：`group` 类留在 `:155`，项目行上的编辑 / 删除 / 新建按钮是 `group-hover:opacity-100`（`:436, :454, :464`）。会话行是 `:155` 的兄弟节点，鼠标划过 session **不会**误触发这些按钮。若为了 sticky 把 `group` 上提到 `:154`，这个隔离就会被破坏。

### 2.2 样式

在 `:155` 的 `cn(...)` 上追加：

```ts
'sticky top-0 z-20 bg-card',                  // 吸顶 + 不透明背景（侧栏底色即 bg-card）
isExpanded && 'border-b border-border/50',    // 展开时加底边，读起来像「分组表头」
```

- **背景必须不透明**，否则滚动内容会从项目头底下透出来。侧栏容器是 `bg-card`（`SidebarContent.tsx:128`），所以 `bg-card` 即无缝。
- **`z-20`** 保证项目头压住 session 卡片；项目行内的悬浮按钮都在 sticky 元素内部，会跟着一起移动。
- **收起态不加底边**：收起时后面没有会话，不需要表头语义。

### 2.3 两个已确认的坑

- **`ScrollArea` 的内层才是滚动容器**（`shared/view/ui/ScrollArea.tsx`：外层 `relative overflow-hidden`，内层 `h-full w-full overflow-auto`）。sticky 相对内层生效，不会被外层的 `overflow-hidden` 吃掉。
- **滚动容器的 `md:px-1.5 md:py-2` 加在外层**（`SidebarContent.tsx:179` 的 className 传给外层），内层是 `w-full h-full`，所以滚动区左右没有缝隙，不会出现「session 卡片从吸顶栏旁边滑过去」的穿帮。

## 3. 会话区面板

`SidebarProjectSessions.tsx:87` 单行改动：

```ts
// 现在
'ml-3 space-y-1 border-l border-border pl-3'
// 改成
'ml-3 space-y-1 rounded-r-lg border-l-2 border-primary/30 bg-muted/25 py-1 pl-3'
```

- 导轨 1px `border` → 2px `border-primary/30`。用 30% 透明度的主题色而不是纯 `border`，是为了在「不引入新色相」的前提下把导轨从背景里拎出来。
- `bg-muted/25` + `rounded-r-lg` + `py-1` 让会话区成为一整块面板，与吸顶的项目头连成视觉整体。
- session 卡片本身是 `bg-card`（`SidebarSessionItem.tsx:185`），坐在淡底面板上会自然浮起来，层级一眼可见。

## 4. 「全部收起」+ 展开后滚入视野

### 4.1 全部收起

`SidebarContent.tsx:152-177` 的「📁 项目」标题按钮现在是 `w-full` 独占一行。改成 flex 行：

```
┌──────────────────────────────────────────────────┐
│ ▾ 📁 项目                            全部收起 ⇕  │
└──────────────────────────────────────────────────┘
```

- 标题按钮加 `flex-1`，右侧兄弟节点是收起按钮，**仅当有项目展开时渲染**。
- 图标用 `ChevronsDownUp`（`lucide-react@0.515` 中已确认存在）。
- 文案硬编码中文 `全部收起`，`title` 为 `收起全部项目` —— 与紧邻的「项目」「展开 项目 / 收起 项目」（`:166, :175`）保持一致。仓库只有 `en` locale（`src/i18n/locales/en/`），这一区块本来就是硬编码中文，不新增 i18n key。

**新增控制器回调**（`useSidebarController.ts`，与 `toggleProject` 并列）：

```ts
const collapseAllProjects = useCallback(() => setExpandedProjects(new Set()), []);
```

**新增两个 props** 从 `useSidebarController` → `Sidebar.tsx:190` → `SidebarContent`：

```ts
hasExpandedProjects: boolean;        // 只传布尔值，不把整个 Set 漏进内容组件
onCollapseAllProjects: () => void;
```

### 4.2 展开后滚入视野

`SidebarProjectItem` 的最外层 div（`:154`，包含项目行与会话区）挂 `ref`，在 `selectAndToggleProject`（`:145`）里**仅当本次是展开**（即 `!isExpanded`）时：

```ts
requestAnimationFrame(() => {
  ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});
```

`block: 'nearest'` 只在元素真的不在视口内时才滚动，避免每次点击都跳一下。

## 5. 边界情况

| 场景 | 行为 |
|---|---|
| 搜索过滤掉部分项目 | 被过滤项目的展开态保留在 `Set` 里（`filterProjects` 只影响渲染，`SidebarProjectList.tsx:132` 的 `expandedProjects.has` 只是查不到），清空搜索后自动恢复展开 |
| 项目被删除 / operator 工作区被隐藏 | `Set` 中的残留 id 不渲染，无害（现有行为） |
| localStorage 写失败 | 已被 `writeStoredExpandedProjects`（`utils.ts:39-45`）静默吞掉 |
| 多展开后列表过长 | 靠「全部收起」+ 展开时滚入视野 + 每项目 20 条分页（`useProjectsState.ts:1090-1105`）兜底 |
| 移动端抽屉 | 同样是 `ScrollArea`，sticky 生效；抽屉更矮，多展开时更依赖「全部收起」 |
| `forceExpanded` prop | **死代码**：`SidebarProjectList.tsx:33` 定义、`:132` 使用，但全仓无任何调用方（默认 `false`），且语义与多展开冲突。本次顺手删除 |

## 6. 测试计划

前端无 DOM 环境，沿用现有模式 `node:test` + `react-dom/server` 的 `renderToStaticMarkup`（见 `web/src/shared/view/ui/Button.test.tsx`）。运行方式：`npx tsx --test <file>`（仓库无 `npm test` 脚本）。

**纯函数（TDD 主体）** —— `web/src/components/sidebar/utils/utils.test.ts`：

- `toggleExpandedProject`：空集合 → 加入；已存在 → 移除；已有其他元素时不影响它们；**不修改入参**（断言传入的 `Set` 在调用后不变）；重复调用两次回到原状

**渲染契约** —— `SidebarProjectSessions` 的 `isExpanded` 分支是真实行为（收起必须渲染 `null`，否则会渲染出空面板），用 `renderToStaticMarkup` 兜住：

- `isExpanded: false` → 输出为空
- `isExpanded: true` → 输出含 `border-l-2` 与 `bg-muted/25`

**刻意不测的**：`SidebarProjectItem` / `SidebarContent` 的类名断言。这两个组件分别有约 30 个和约 40 个 props，为了断言几个 Tailwind 字符串去搭一整套替身不划算；而这些字符串的**真实验证只能靠布局引擎**，断言常量本身是自证。

**测不了的（必须手动在浏览器验证）**：sticky 的包含块、滚动容器的 padding 边界都由 CSS 布局解析，无 DOM 环境下无法验证。手动清单：

1. 桌面端：展开一个 20 条以上的项目，滚动 —— 项目名应一直贴在滚动区顶部，滚到列表末尾时被下一个项目顶走
2. 同时展开两个项目 —— 两个都保持展开，各自的头分别吸顶
3. 「全部收起」一键复位；无展开项目时按钮不出现
4. 展开靠下方的项目 —— 自动滚入视野
5. 移动端抽屉（`< 768px`）：同样的滚动 / 吸顶行为，且不遮挡底部「最近任务」「定时任务」区块

**验收**：`npm run typecheck`、`npm run lint` 零新增（仓库 baseline 本身有 pre-existing 错误）。

## 7. 不在范围内

- **项目色**（按 `projectId` 哈希分配稳定强调色）：收益在分组已经做明确之后边际不大，却要付出配色系统冲突的代价。将来若仍觉得不够，可以叠在本次改动上加，不需要返工。
- 「最近任务」区块的跨项目归属提示（`SidebarRecentSessions.tsx:95-98` 的项目名是 10px 灰字）—— 用户确认本次不做。
- 项目行的路径截断 / 重名区分 —— 用户确认本次不做。
- session 行上的项目面包屑 —— 与嵌套结构重复，会加噪音。
- 侧栏整体宽度、折叠态窄条（`SidebarCollapsed.tsx`）的行为。

## 8. 影响面与风险

- **吸顶依赖 `SidebarProjectItem.tsx:154-155` 的层级**。若将来有人在 `:154` 与 `:155` 之间插入带 `overflow: hidden/auto/scroll` 的容器，sticky 会**静默失效**（不报错，只是不吸顶）。实现时在 `:155` 处留一条注释说明这个约束。
- **多展开后列表会明显变长**，这是功能本身的代价。缓解手段是「全部收起」+ 滚入视野，但用户仍可能一次展开过多。
- **展开态下的 `border-b` 在未吸顶时也可见**，视觉上是否可接受需要在浏览器确认；若显得多余，可退化为仅在吸顶时显示（需要 `IntersectionObserver`，成本更高，先不做）。
- **多展开与「最近任务」的交互**：两者独立，`getRecentSessions`（`utils.ts:169`）取的是跨项目 top-10，不受展开态影响。
- **`forceExpanded` 的删除**会改动 `SidebarProjectList` 的 props 签名，但既然无调用方，编译期即可暴露遗漏。
