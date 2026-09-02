# 添加设备一条龙（Complete Add-Device Flow）设计

日期：2026-09-02
状态：已确认（自动装依赖 + 自动隧道 + 成功门槛=真正在线）

## 背景与目标

当前「添加远程机器」是**半成品**：`AddRemoteHostDialog` 一键串了「注入公钥 → 注册(插 DB 行) → 部署(bootstrap)」，但存在三处断点，导致用户添加完设备后，设备要么报错、要么不在「新建项目」里出现：

1. **前置依赖没检查/没安装**：目标机缺 node(≥20)/claude 时，bootstrap 直接报 `node not found on remote — install node >=20 first (see deploy/install.sh)`，且这句指向的 `install.sh` 其实**并不装 node**（它要求 node 已存在，否则 exit 1），是个误导性提示。
2. **"成功"是假成功**：`AddRemoteHostDialog` 把「install.sh 跑完（status=online）」当成添加成功就关窗，但 lite 可能根本没连回主站（`online=false`），于是新建项目里看不到。设置页 `RemoteHostsSettingsSection` 已经正确区分「在线(绿点, online=true)」与「未连接(黄点, status=online 但 online=false)」，但添加弹窗没有继承这个判断。
3. **回连方式事后手动补**：隧道开关在设置列表里单独做，添加流程完全不涉及；公网/NAT 机器不加隧道或不配公网 URL 就永远连不回主站。

目标：把「添加设备」做成**完整闭环**——添加结束时设备**真正在线**（lite 已连回），立即出现在「新建项目」下拉里。

已确认决策：

- **依赖**：目标机缺 node(≥20)/claude 时**自动安装**。
- **回连**：主站没配 `LOVDEX_PUBLIC_WS_URL` 时**自动建 ssh -R 反隧道**；配了则直连。
- **成功标准**：只有 lite 真正连回（`online=true`）才算「添加成功」并关窗。

## 现状（关键事实）

- `backend/server/modules/remote-agents/bootstrap.service.ts` `runBootstrap()` 顺序：`uname` 探针 → `node -v` 探针 → `claude -v` 探针 → `mkdir ~/.lovdex-remote` → 写 config.json/env → push install.sh + systemd unit + lite.tgz → 跑 install.sh。node/claude 探针失败直接 return error，无安装动作。
- `backend/remote-agent/deploy/install.sh`：只负责解包 tarball、`npm ci`（bundle 时跳过）、渲染 systemd unit（用 `command -v node/claude` 解析绝对路径）、enable+restart。**不装 node/claude**，且 `command -v` 失败即 exit 1。
- `backend/server/modules/remote-agents/remote-agents.routes.ts`：
  - `POST /` 注册：密码模式先 `sshpass` 注入公钥，成功才 `repo.create` 插行，`tokenFor(hostId)` 生成并持久化 token hash。
  - `POST /:hostId/deploy`：`repo.updateStatus(hostId, 'deploying')` → 若 `host.tunnel_port !== null` 则 `tunnels.ensure(host)` → `runBootstrap`（serverUrl = tunnel 时 `ws://127.0.0.1:<port>`，否则 `deps.serverUrl`）→ 按 `result.status==='online'` 落库 status（注意：这只代表 install.sh 退出码 0，不代表 lite 连回）。
  - `POST /:hostId/tunnel`：显式传端口建隧道；`deps.repo.setTunnelPort` + `tunnels.ensure`。**无端口自动分配**。
- `backend/server/modules/remote-agents/remote-tunnels.ts`：`createRemoteTunnels({identityFile, forwardPort})` 按 `host.tunnel_port` 跑 `ssh -N -R 127.0.0.1:<port>:127.0.0.1:<mainPort>`；断线指数退避重连；`syncFromHosts()` 启动时按 `tunnel_port` 非空者重建。要求显式 `tunnel_port`。
- `backend/server/modules/remote-agents/remote-host.db.js`（`remoteHostsDb`）：管理 `remote_hosts` 表，含 `tunnel_port` 列，`setTunnelPort(hostId, port)` 已存在。
- 主回连地址 `deps.serverUrl = process.env.LOVDEX_PUBLIC_WS_URL ?? ws://localhost:${port}/api/remote-agents/ws`（`index.js` 装配 router 时）。
- 前端 `AddRemoteHostDialog.tsx`：`run()` 串注册→部署→`pollUntilSettled`；成功分支是 `deployStatus === 'online' || terminalRow?.online || terminalRow?.status === 'online'`（把 `status==='online'` 当成功）。
- 前端 `RemoteHostsSettingsSection.tsx`：`deriveHostState()` 区分绿点(online=true)/黄点(status=online 但未连回)/红点(error)/灰点(offline)，部署后 `waitForTerminal(30s)` 等绿点。**这是正确的判定样板**。
- 前端 `project-creation-wizard/data/workspaceApi.ts` `fetchOnlineRemoteHosts()`：`GET /remote-agents` 后 `.filter(host => host.online)`，只列 lite 已连回的主机。
- `online` 字段后端来自 `deps.registry.isOnline(host_id)` = lite 的 WS `readyState === OPEN`（`remote-agents.registry.ts`），与 DB `status` 无关。

## 总体方案

三处改动闭环：

1. **后端**：bootstrap 增加前置依赖自动安装（缺就装）；deploy 路线增加**自动隧道**（未配公网 URL 时自动分配端口并建隧道）；探针报错信息精确化。
2. **前端**：`AddRemoteHostDialog` 成功门槛改成「真正在线」，阶段提示丰富为四步，与设置页判定一致。
3. **不改**「新建项目只列 online」的过滤——上游保证添加结束一定 online。

### 1. 前置依赖自动安装（`prepare-remote.sh`）

新增 `backend/remote-agent/deploy/prepare-remote.sh`（与 install.sh 平级，bootstrap 通过 FilePush 推送后运行）。幂等、`set -euo pipefail`：

- 检查 `node -v` 且主版本 ≥ 20；缺或版本不足：
  - `sudo -n true` 探测无密码 sudo；无则打印**确切手动命令**并 exit 1（不挂死）。
  - 下载官方 Node 22 LTS linux-x64 tarball（`curl -fsSL https://nodejs.org/dist/<pinned>/node-v<pinned>-linux-x64.tar.xz`，版本为后端常量）→ `sudo tar -xJf` 解到 `/usr/local`（`--strip-components=1`）→ 校验 `node -v`。
- 检查 `claude -v`；缺：`sudo npm i -g @anthropic-ai/claude-code`（node 就位后 npm 可用）→ 校验 `claude -v`。
- 网络下载失败、sudo 不可用、安装后校验仍失败 → 输出可读原因 + 手动安装命令，exit 1。

bootstrap 重排（`runBootstrap`）：

```
uname 探针 → mkdir ~/.lovdex-remote → push prepare-remote.sh → 跑 bash prepare-remote.sh
→ node -v 复探（只为产出准确报错）→ claude -v 复探 → 写 config.json/env → push install.sh + unit + lite.tgz → 跑 install.sh
```

- 已装依赖的目标机：prepare-remote.sh 近乎空跑（两次 `command -v`），几乎不增加耗时。
- 复探失败信息区分「node 缺失/版本不足」「claude 缺失」「自动安装失败(带 stderr 原因)」，**替换掉**现那句误导的 "see deploy/install.sh"。
- prepare-remote.sh 用与 install.sh 相同的 `SshRunner`/`FilePush` 缝（发 argv 数组/heredoc，不做 shell 拼接注入），保持可单测。
- **无 FilePush 缝时**（`runBootstrap` 的 partial 单测路径 / 未接线）：跳过 push+run prepare，退化为「直接 node/claude 探针，缺则 error」，保持现有 partial 契约不变。

### 2. 自动隧道（deploy 路线 + 端口分配）

`remote-agents.routes.ts` 的 `POST /:hostId/deploy` 决定回连地址，优先级（从高到低）：

1. `host.tunnel_port` 已存在（历史遗留/用户手动开过）→ **沿用隧道**（`tunnels.ensure` + `ws://127.0.0.1:<port>`），不因配置变化悄悄改直连。
2. 否则主站设了 `LOVDEX_PUBLIC_WS_URL` → **直连**：`serverUrl = deps.serverUrl`（即该公网 URL），不建隧道。
3. 否则（未配公网 URL 且无历史隧道）→ **自动隧道**：
   - `remoteHostsDb.allocateTunnelPort()` 分配唯一端口，`setTunnelPort(hostId, port)` 持久化。
   - `tunnels.ensure({...host, tunnel_port: port})` 建 `ssh -R`。
   - `serverUrl = ws://127.0.0.1:<port>/api/remote-agents/ws`。
- 隧道端口持久化后，重启时 `syncFromHosts()` 会自动重建，无需新机制。

`remote-host.db` 新增 `allocateTunnelPort()`：

- 取现有 `tunnel_port` 占用的集合，在 `[20000, 60000]` 内选空闲端口（从 `max(20000, 现有最大+1)` 起，命中占用则 +1 递增到空闲）。
- 纯内存扫描数据库行即可，无需全局计数状态；分配结果持久化到行，重部署复用同端口（token 相同的思路：不因失败部署轮换端口）。

`router deps` 增加 `publicWsUrl: string | null`（`index.js` 装配时传 `process.env.LOVDEX_PUBLIC_WS_URL ?? null`），供 deploy 路线判断直连 vs 隧道。

### 3. 前端成功门槛（`AddRemoteHostDialog.tsx`）

- `run()` 阶段提示：`注入公钥中…` → `准备依赖…`（部署包含 prepare 阶段）→ `部署中…` → `等待上线…`。
- 注册、部署不变；部署返回后**不**再把 `deployStatus==='online'` 当成功，改用轮询等 `online===true`（复用设置页 `waitForTerminal` 的 30s 门槛逻辑，抽出公共函数或在 dialog 内实现同语义）：
  - 30s 内 `online===true` → `onAdded()` + `onClose()`（真成功）。
  - 超时未绿 → 保留弹窗、显示黄点语义文案「部署完成但 lite 尚未连回主站（检查隧道/网络后重试）」，host 行已存在（`onAdded()` 刷新列表），用户可关闭后去设置页看黄点/重试。
- 成功判定标准与 `RemoteHostsSettingsSection.deriveHostState()` 完全一致，消除两处「成功」定义不一致。

## 数据流（添加一次设备的完整时序）

```
用户填 名称/主机/端口/用户/认证 → 点「添加并部署」
 1. POST /remote-agents         → 密码模式 sshpass 注入公钥 → repo.create 插行 → tokenFor 持久化
 2. POST /:hostId/deploy
    2a. updateStatus('deploying')
    2b. 直连/隧道判定 → 需要隧道则 allocateTunnelPort + setTunnelPort + tunnels.ensure
    2c. runBootstrap:
        uname → mkdir → push+run prepare-remote.sh（缺 node/claude 则自动装）
        → node/claude 复探 → 写 config.json/env（serverUrl 已按隧道/直连确定）
        → push install.sh + unit + lite.tgz → run install.sh → systemd enable+restart lite
 3. 前端轮询 GET /remote-agents，直到 online===true（至多 30s）
     → 绿点：关窗，设备出现在「新建项目」下拉
     → 超时：黄点「未连接」，保留主机行可重试
```

lite 启动后按 config.json 的 `serverUrl` 出站连主站（隧道则 `ws://127.0.0.1:<port>`，直连则公网 URL）→ `hello` 注册 → 主 `registry.register` → `isOnline=true` → 新建项目可见。

## 错误处理与边界

| 情形 | 行为 |
|---|---|
| 远程无外网 / tarball 或 npm 下载失败 | prepare 脚本失败，bootstrap 报「自动安装失败: <stderr>」，弹窗显示原因 + 手动安装命令 |
| sudo 需要密码（非 passwordless） | prepare 探测 `sudo -n` 失败，跳过自动装、给出手动命令，不挂死 |
| node 存在但版本 < 20 | prepare 走安装路径覆盖升级，复探满足 ≥20 |
| 主站配了 `LOVDEX_PUBLIC_WS_URL` | 直连，不建隧道 |
| 隧道端口冲突 | `allocateTunnelPort()` 扫描已用端口避开（同一主机/跨主机均唯一） |
| lite 30s 内没连回 | 黄点「未连接」，保留行，可重试；不假成功关窗 |
| 部署中途失败（node/claude/install 任一步） | `updateStatus('error', message)`，弹窗红点显示精确原因 |

## 测试

- `bootstrap.service.test.ts`：node/claude 缺失 → 断言发出 prepare 安装命令（push 到远端 + `bash prepare-remote.sh`）并复探；安装失败 → 断言 error 消息含「node/claude」与失败原因；已装依赖 → prepare 空跑不影响 happy path。
- `remote-host.db.test.ts`：`allocateTunnelPort()` 分配唯一端口、避让已用端口、落在 `[20000,60000]`。
- 路由层（`remote-agents.routes.test.ts`）：`publicWsUrl` 设/未设两分支——设了走直连 serverUrl 且不建隧道；未设自动分配 + `tunnels.ensure` 被调用、serverUrl 为 `ws://127.0.0.1:<port>`。
- 前端（可选，若现有 dialog 有测试骨架）：成功门槛只在 `online===true` 时触发 `onAdded`/`onClose`；超时走黄点文案。

## 明确不做（YAGNI）

- 不做「探测到直连就自动禁用隧道」的连通性探测——规则只依据 `LOVDEX_PUBLIC_WS_URL` 是否配置，简单确定。
- 不改「新建项目」只列 `online` 的过滤——上游保证添加结束一定 online。
- 不把「自动安装」做成可选开关（已确认默认自动装）。
- 不做 Windows/macOS 目标的自动安装（tarball/apt 路径仅覆盖 Linux；`prepare-remote.sh` 对非 Linux 打印「请在目标机手动安装」）。