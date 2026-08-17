# Lovdex Supervisor

零依赖 Node 守护脚本，拉起并守护 `backend`（3188）与 `web`（5188）。进程不在就拉起（含正常退出），带指数退避（1s→30s，跑满 10s 重置）。

## 开发模式（前台）

```bash
node supervisor.mjs            # MODE=dev 默认；前台跑，日志带颜色前缀
```

`Ctrl+C` 一次性优雅停掉前后端。后端用 `npm run dev`（tsx），前端用 `npm run dev`（vite）。

## 常驻模式（systemd）

prod 模式后端用 `npm run dev`（tsx 直跑源码——后端 `npm run build` 目前有存量 TS 错误，修好后可在 `services.mjs` 切回 `npm start`），前端用 `npm run preview`（构建产物）。前端 dist 缺失时自动 `npm run build`。

```bash
# 一次性安装
mkdir -p ~/.config/systemd/user
cp ../systemd/lovdex.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lovdex.service
sudo loginctl enable-linger zhijuhuang   # 开机自启关键，需一次 sudo
```

日常：

```bash
systemctl --user {start,stop,restart,status} lovdex
journalctl --user -u lovdex -f                    # supervisor 自身日志
tail -f logs/{backend,frontend}.log               # 各服务日志
```

## 子命令

```bash
node supervisor.mjs            # start（默认）
node supervisor.mjs stop       # 读 run.pid 发 SIGTERM，优雅停整栈
node supervisor.mjs status     # supervisor + 各服务存活状态 + 最近日志
```

## 文件

- `supervisor.mjs` — 守护脚本本体
- `services.mjs` — 服务定义（命令、cwd、端口、dist 目录）
- `logs/` — prod 模式日志（`backend.log` / `frontend.log` / `supervisor.log`）
- `run.pid` / `run.state.json` — 运行时 pid 与状态（stop/status 用）

## 退避与重启

子进程 exit（无论 code）→ 退避后重启。退避 1s 起，每次连续快速崩溃翻倍，上限 30s；连续运行满 10s 重置回 1s。supervisor 自身由 systemd `Restart=always` 兜底。

## 端口接管

supervisor 以**端口所有权**为准：每次启动/拉起服务前检查 `3188` / `5188`，如果被**任何其它进程**占着（不管是谁启动的——手动 `npm run dev`、别的会话、昨天的残留都算），先 SIGTERM 它，2 秒内不退出就 SIGKILL，然后启动自己的子进程接管。接管后端口只归 supervisor 的进程所有，子进程一退出就拉起。
