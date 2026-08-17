# Lovdex 守护进程设计

日期：2026-08-08

## 背景与目标

Lovdex 由两个独立 git 仓库组成：

- `lovdex-backend/` — Express + WebSocket 后端，端口 3001。`npm run dev`（tsx 直跑 `server/index.js`）或 `npm start`（`node dist-server/server/index.js`，编译产物）。
- `lovdex-cli/` — Vite 前端，端口 5187。`npm run dev`（vite）或 `npm run preview`（vite preview，跑构建产物）。

两者都在父目录 `lovdex/` 下，该父目录与 `docs/` 均不在 git 中。

痛点：后端退出方便，但不会自动起来，开发时常被打断；也希望能在常驻/服务场景下运行。

目标：一套守护机制同时满足两种场景：

1. **开发场景** — 一条命令拉起前后端，任一进程不在了就拉起，`Ctrl+C` 整体优雅停掉。
2. **常驻/服务场景** — 开机自启，机器重启后自动起来，崩溃自愈。

约束：

- 系统为 Ubuntu 20.04，systemd（PID 1），Node v22（nvm），未安装 pm2/nodemon。
- 选用 **零依赖的 Node 守护脚本 + systemd user unit** 方案：脚本负责拉起/监控/重启前后端子进程，systemd 把脚本本身托管起来实现开机自启和兜底自愈。
- 守护脚本与配置文件放在父目录 `lovdex/supervisor/` 与 `lovdex/systemd/` 下，与 `docs/` 一样不进入两个子仓库的 git。

## 非目标（YAGNI）

- 不做日志轮转（量不大，需要时再上 logrotate）。
- 不做端口探测阻塞等待就绪（只保证启动顺序）。
- 不写自动化测试（脚手架/运维脚本，手动验证即可）。
- 不做分布式/多机管理。

## 总体架构

```
lovdex/
  supervisor/
    supervisor.mjs     # 守护脚本：单文件，零依赖，纯 Node ESM
    services.mjs       # 服务定义：backend / frontend 在 dev/prod 下的命令、cwd、端口
    logs/              # 各服务日志（带时间戳，按服务分文件；gitignored）
    run.pid            # supervisor 自己的 pid 文件，供 stop/restart/status 子命令用
    README.md          # 用法说明
  systemd/
    lovdex.service     # systemd --user unit（MODE=prod 常驻）
```

两种用法共用同一个脚本，靠 `MODE` 环境变量切换：

- **开发**：终端里 `node supervisor/supervisor.mjs`（默认 `MODE=dev`）。前台运行，日志直接打到终端，带颜色前缀；`Ctrl+C` 一次性优雅停掉前后端。
- **常驻**：`systemctl --user enable --now lovdex.service`（unit 内设 `MODE=prod`）。systemd 负责开机自启、supervisor 崩溃自愈；supervisor 负责前后端不在就拉起。

## 服务定义

| 服务 | dev 命令 | prod 命令 | 端口 | cwd |
|---|---|---|---|---|
| backend | `npm run dev`（tsx 直跑 `server/index.js`） | `npm start`（`node dist-server/server/index.js`） | 3001 | `lovdex-backend/` |
| frontend | `npm run dev`（vite） | `npm run preview`（vite preview） | 5187 | `lovdex-cli/` |

`services.mjs` 以数据形式描述上述定义；`supervisor.mjs` 读取它来构造每个子进程的 spawn 参数。

启动顺序：后端先起、前端后起（前端 vite dev proxy 依赖后端 3001 在）。supervisor 不做端口探测阻塞，只保证启动顺序；前端起来时后端通常已在。

### prod 模式 dist 检查与自动 build

prod 模式启动前，supervisor 检查以下目录是否存在：

- `lovdex-backend/dist-server/`
- `lovdex-cli/dist/`

任一不存在 → 自动在该子仓库内运行一次 `npm run build`，构建成功后再启动对应服务；构建失败则记录错误、该服务进入退避重试（见下），其余服务照常。

## 重启策略

- **子进程**：进程 exit（无论 exit code，包括正常退出）→ 退避后重启。退避从 1s 起，每次连续快速崩溃翻倍，上限 30s；某次连续运行满 10s 后退避重置回 1s。避免后端启动失败时狂拉。
- **supervisor 自身**：systemd unit 设 `Restart=always` + `RestartSec=5`，supervisor 崩了 systemd 兜底拉起。

## 信号与优雅停止

- supervisor 收到 `SIGINT` / `SIGTERM` → 给所有子进程发 `SIGTERM`，等待最多 5s（grace period）；超时仍未退则对存活子进程发 `SIGKILL`，然后 supervisor 自己退出。
- 这样 `Ctrl+C`（dev）和 `systemctl --user stop`（prod）都能干净停掉整栈。
- 子进程收 `SIGTERM` 后由各自（tsx / vite / node）自行清理。

## 子命令

`supervisor.mjs` 支持以下调用形式：

- `node supervisor/supervisor.mjs`（无参数 / `start`）— 拉起前后端并守护，前台运行。
- `node supervisor/supervisor.mjs stop` — 读 `run.pid`，向 supervisor 进程发 `SIGTERM`（由 supervisor 自己完成子进程的优雅停止）。
- `node supervisor/supervisor.mjs status` — 读 `run.pid` 判断 supervisor 是否存活；列出各子进程存活状态；打印各服务最近几行日志。

pid 文件 `run.pid` 在 supervisor 启动时写入自身 pid，退出时删除。

## 日志

- **dev**：各服务 stdout/stderr 直接转发到 supervisor 的 stdout，加 `[backend]` / `[frontend]` 前缀与颜色，方便终端查看。
- **prod**：各服务 stdout/stderr 写入 `supervisor/logs/{backend,frontend}.log`，按行加时间戳前缀；supervisor 自身的元事件（启动/重启/退避/构建）写入 `supervisor/logs/supervisor.log`。

## systemd user unit

`systemd/lovdex.service`：

```ini
[Unit]
Description=Lovdex supervisor (backend + frontend)
After=network.target

[Service]
Type=simple
WorkingDirectory=/mnt/b/workdir/github/lovdex
Environment=MODE=prod
ExecStart=/home/zhijuhuang/.nvm/versions/node/v22.22.0/bin/node /mnt/b/workdir/github/lovdex/supervisor/supervisor.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

说明：systemd 不经 shell，必须用 node 的绝对路径（nvm 装在用户家目录）。ExecStart 指向 `supervisor.mjs`，WorkingDirectory 设为父目录 `lovdex/`，supervisor 内部按 `services.mjs` 里的相对路径切到各子仓库。

安装（一次性）：

```bash
mkdir -p ~/.config/systemd/user
cp systemd/lovdex.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lovdex.service
sudo loginctl enable-linger zhijuhuang   # 让用户服务在未登录时也跑，开机自启关键
```

之后日常：

```bash
systemctl --user {start,stop,restart,status} lovdex
journalctl --user -u lovdex -f           # supervisor 自身日志
tail -f supervisor/logs/{backend,frontend}.log   # 各服务日志
```

## 错误处理

- 子进程启动失败（spawn 报错）→ 等同于 exit，进入退避重试。
- prod 模式 `npm run build` 失败 → 记录错误到 `supervisor/logs/supervisor.log`，该服务进入退避重试；其余服务照常。
- pid 文件存在但进程不存在（上次异常退出残留）→ `stop`/`status` 子命令检测到后清理残留 pid 文件。
- 退避达到上限（30s）后不再继续放大，持续尝试拉起。

## 验证

手动验证（不写自动化测试）：

- **dev**：`node supervisor/supervisor.mjs` 起来后，`kill -9` 后端进程 pid → 确认 supervisor 在退避后拉起；`Ctrl+C` → 确认前后端都干净退出，无残留。
- **prod**：`systemctl --user stop lovdex` → 后端被杀 → systemd 重拉 supervisor → supervisor 重拉前后端；`systemctl --user status lovdex` 正常。
- **开机自启**：`sudo loginctl enable-linger zhijuhuang` 后，重登或重启机器，确认 supervisor 自动起来、前后端恢复。

## 环境

- Node：`/home/zhijuhuang/.nvm/versions/node/v22.22.0/bin/node`
- 项目根：`/mnt/b/workdir/github/lovdex`
- 用户：`zhijuhuang`
