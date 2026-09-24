# 收件箱「忽略」动作设计（失败条目 → 归档）

日期：2026-09-24
状态：已批准（方案 A）

## 背景与痛点

定时任务（及手动任务）失败后，任务行停在 in_progress 列、持久化 `sub_status='failed'`（两层状态模型）。任务页「需要你处理」收件箱按 `sub_status` 派生条目，失败条目**只有「重试 / 打开会话 / 查看」三个动作**，没有「不再提醒」的中间态。用户不想重试时，唯一出路是**删除任务行**（运行记录行随之消失、关联会话级联硬删、不可恢复）。2026-09-24 实际发生了这个歧义：用户说「清理掉」，本意是「提醒别再烦我，失败历史留着」，结果历史被删了。

## 目标

失败条目获得非破坏性的退出口：**忽略 = 归档**。提醒消失，历史保留，之后仍可删除。

## 非目标

- blocked / waiting_* / only_plan / needs_review 等等待人工的条目不加忽略（维持现状，YAGNI）。
- 不做本地隐藏（localStorage 记 id）类方案：跨设备不同步、换端复发。
- 运行记录视图不加忽略入口（那里已有删除；忽略的黄金时刻在收件箱）。
- 不改删除路径（上一修复已让失败运行可删）。

## 交互设计

- `TaskInboxPanel` 失败条目（`signal === 'failed'`）：在「↻ 重试」旁并列「🗄 忽略」按钮（muted 样式，弱于重试）。
- 点击**不弹确认框**：归档非破坏性、可逆（详情页「取消归档」→ done）、运行记录随时可见，弹窗是打扰。
- 点击后条目应立即消失（任务归档 → `filterTasks` 默认 `showArchived=false` 把它滤出 `filteredTasks` → `attentionItems` 不再产出该条）。

## 后端改动（一处条件）

`tasks.service.ts` `applyStatusChange` 中 `archived` 的进入守卫：

- 现状：`row.status !== 'done'` → 400 `only completed tasks can be archived`。
- 放宽为：`row.status === 'done' || (row.status === 'in_progress' && row.sub_status === 'failed')`。
- 其余语义不变：
  - 只有 user actor 能归档（引擎 double guard 保留）；
  - archived 只能出（回 done），取消归档后失败标签**不恢复**（`updateTaskSubStatus(null)` 已在归档转变时清掉）——「认账」语义，文档注释里写明；
  - 归档副作用（隐藏关联会话 `updateSessionIsArchived(true)`）沿既有代码路径照走，失败运行与 done 归档一致。

## 数据流与连带效果（自查清单）

| 关注点 | 归档后的行为 | 依据 |
|---|---|---|
| 收件箱条目 | 消失 | `filterTasks` 丢 archived（`taskFilter.ts:133`），`attentionItems` 收到的列表里已没有它 |
| 任务看板/表格 | 消失（默认视图） | 同上；`showArchived` 打开时可见 |
| 运行记录 | **保留**，状态徽标「已归档」 | `runsOf` 只看 `source_schedule_id`，不筛状态 |
| 调度下一轮 | 不受影响 | `isRunActive`：archived ≠ in_progress → 不算阻塞 |
| 之后删除 | 允许 | `isUndeletable`：非 in_progress，仅 registry 兜底 |
| 重试入口 | 随条目消失 | 若反悔：详情页「取消归档」→ done，再手动重跑 |

## 测试计划

后端（`tasks.service.test.ts` 或 status 集成测试）：

1. `in_progress + sub_status='failed'` → 归档成功，sub_status 清空，关联会话 `isArchived=true`。
2. `in_progress + sub_status=null（真在跑）` → 归档仍 400。
3. `in_progress + sub_status='blocked'` → 400（未放开）。
4. `done → archived` 既有行为不回归；`archived → in_progress` 仍 400（只能回 done）。

前端（无 DOM，`renderToStaticMarkup` 静态断言）：

5. `TaskInboxPanel.test.tsx`：`signal==='failed'` 条目渲染「忽略」按钮；`blocked` 条目不渲染。
6. `taskInbox.test.ts`：`AttentionAction` 联合类型扩展后既有断言不回归。

## 影响面

- 后端：`tasks.service.ts`（1 处条件 + 注释）、测试。
- 前端：`taskInbox.ts`（`AttentionAction` 加 `'ignore'`）、`TaskInboxPanel.tsx`（按钮 + handlers 映射）、`TaskBoard.tsx`（传 `onIgnore={(t) => updateStatus(t, 'archived')}`）、测试。
- 无 schema 变更、无新端点（复用 `POST /api/tasks/:taskId/move`）。
