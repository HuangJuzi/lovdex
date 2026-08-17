# 全站 chunky 风格统一 · 设计文档

日期:2026-08-13
状态:经 mockup 确认(whole-page-chunky-mockup.html)

## 目标

将整个前端**框架层界面**(侧栏、页面头、任务看板两视图、任务详情、弹窗、设置、终端抽屉外壳、聊天框架)按 W4「立体厚板」风格统一重做。内容区(聊天气泡、正文排版、富文本)保持现状。

## ⚠️ 硬约束:只改风格

- **只允许修改** `className` / Tailwind 类字符串、cva variant 类、样式常量。
- **禁止修改**:逻辑、数据流、状态、API 调用、组件结构/层级、DOM 标签、aria/role/语义属性、onClick 等行为属性、i18n 文案。
- 若一个元素只需改样式但结构上绕不开,报告 DONE_WITH_CONCERNS 不要自作主张重构。
- 暗色模式必须同样成立(用 `dark:` 覆盖)。

## chunky 语言(样式配方)

统一尺寸与质感基线,所有类字符串直接内联到目标元素上:

### 卡片配方(白卡 + 硬底边 + 大圆角)
```
CHUNKY_CARD = rounded-2xl border border-border/70 bg-card text-card-foreground shadow-[0_3px_0_rgba(30,27,50,0.07),0_12px_26px_rgba(35,33,41,0.07)]
```

### 输入/选择框(2px 硬边 + focus 蓝环)
```
CHUNKY_INPUT = h-10 w-full rounded-xl border-2 border-border bg-card px-3.5 text-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-primary/60 disabled:cursor-not-allowed disabled:opacity-50
```

### 导航/激活项(白卡硬底边)
```
CHUNKY_NAV_ACTIVE = bg-card font-medium text-card-foreground shadow-[0_3px_0_#d8d5cd,0_6px_16px_rgba(35,33,41,0.07)]
CHUNKY_NAV_HOVER  = hover:bg-muted
```

### 分段切换(PillBar / ViewSwitcher)
```
CHUNKY_GROUP  = rounded-xl border border-border/70 bg-muted/60 p-[3px]
CHUNKY_ACTIVE = bg-card text-card-foreground shadow-[0_2px_0_rgba(30,27,50,0.10),0_4px_10px_rgba(35,33,41,0.06)]
```

### 弹窗
```
CHUNKY_DIALOG      = rounded-2xl border border-border/80 bg-popover text-popover-foreground shadow-[0_3px_0_rgba(30,27,50,0.08),0_24px_60px_rgba(20,17,12,0.28)]
```

### 小动作按钮(Pill 外的最小按钮)
```
CHUNKY_PILL = rounded-lg border border-border/70 bg-card text-card-foreground shadow-[0_2px_0_rgba(30,27,50,0.08)]
```

## 落地范围(框架优先)

| 面 | 文件 | 要点 |
|---|---|---|
| 共享组件 | Card / Input / Dialog / PillBar / Badge / ViewSwitcher | 配方下沉,全局跟随 |
| 侧栏 | SidebarContent / SidebarProjectList / SidebarHeader / SidebarAssistant | 导航项激活=白卡硬底边;搜素/输入 2px 硬边;容器实心白 |
| 任务看板 | TaskBoard / TaskCard / TaskFilterBar / TaskTableView | 看板列头、任务卡、筛选 pill、表格容器 |
| 任务详情 | TaskDetail | 面板用卡片配方、徽章圆角 |
| 聊天框架 | ChatInterface 头、PromptInput 提交钮、ConvertToTaskDialog、终端抽屉外壳 | 头部齐平;消息区不动 |
| 弹窗 | TaskBoard 新建任务表单 | 输入/选择走 CHUNKY_INPUT |

## 不改动

- 聊天气泡、正文排版、富文本渲染器。
- 终端抽屉内部(暗色终端本体)。
- 所有逻辑/行为/结构(见硬约束)。

## 测试

- 每任务后 `npm run typecheck` 归零。
- 完成后全量测试套件(现状 222 项)必须全绿,不得出现行为回归。