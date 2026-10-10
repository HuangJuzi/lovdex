# 大文件上传（本机 10GB + 远程分片流式）设计

日期：2026-10-10
状态：已确认，待写实现计划
相关：`2026-08-19-remote-file-git-provider-design.md`（远程上传 32MB 单一上限的来源）

## 0. 背景

当前上传文件有两个 200MB 级别的门槛，都写死在源码常量里：

- **本机**：前端 `web/src/components/file-tree/constants/constants.ts:9` 的 `MAX_FILE_UPLOAD_SIZE_MB = 200`，后端 `backend/server/index.js:140` 同名常量。两边同步，前端只做预校验，后端 multer 的 `limits.fileSize` 才是权威。
- **远程项目**：另有更低的 32MB 硬顶。`REMOTE_MAX_UPLOAD_BYTES = 32 * 1024 * 1024`（`backend/server/modules/remote-agents/remote-fs.service.ts:9`）。远程上传把整个文件 `readFile` 成 Buffer → base64 → 单帧 WS RPC（`index.js:1660-1678`）。

远程的 32MB 不是随手定的，是**被迫**的。整条链路上有三重天花板：

1. `ws` 两侧（main 的 `WebSocketServer`、lite 的 `WebSocket`）默认 `maxPayload = 100MiB`，单帧超了直接断连；
2. base64 让体积膨胀 4/3，所以 100MiB 帧的源码天花板是 75MiB；
3. Node 的 `buffer.constants.MAX_STRING_LENGTH = 512MiB`。`JSON.stringify` 一个含超长字符串的对象时，V8 会做**扁平化拷贝**，顶层字符串长度逼近 512MiB 就抛 `RangeError: Invalid string length`（已实测）。

三者叠加，且 `64MiB × 4 / 3 = 85.3MiB` 已经很贴近 100MiB 帧上限、没有余量（permessage-deflate 在不可压缩二进制上只会膨胀）。所以「远程单文件想真正大」必须**换传输方式**，简单调大常量做不到。

需求确认：远程偶尔要传 1–2GB；失败重传即可，不需要断点续传。

## 1. 决策汇总

| 项 | 结论 | 理由 |
|---|---|---|
| 本机单文件上限 | 200MB → **10240MB（10GB）** | 用户选定 |
| 上传写入上限 | 与单文件上限同值 10GB | 同一常量，避免两套数 |
| 远程单文件上限 | 32MB → **10GB** | 与「一并抬高」的意图一致，由分片实现支撑 |
| 本机上传磁盘峰值 | 2× → **1×** | 顺手修，否则 10GB 打满磁盘 |
| 远程传输方式 | 新增 `fs/uploadBegin/Chunk/End` 三个 RPC，**主侧窗口式切片流式写** | 方案 A，用户选定 |
| 分片大小 | **4MiB** | base64 后 ~5.33MiB，远离 100MiB 帧上限；内存与吞吐平衡 |
| 断点续传 | **不做** | 用户选定重传即可；只做失败清理 |
| 远程读回（预览/下载） | **维持 32MiB 不变** | 预览走内存，1–2GB 不适合；下载是独立课题 |
| `ws` `maxPayload` | **不改** | 4MiB 分片下默认 100MiB 绰绰有余 |
| 「下载大文件」功能 | **明确不做** | 见 §4 说明，超出本次范围 |

## 2. 前端（不区分本地/远程）

`web/src/components/file-tree/constants/constants.ts`：

- `MAX_FILE_UPLOAD_SIZE_MB` 200 → `10240`。
- `MAX_FILE_UPLOAD_SIZE_LABEL` 由它派生，自动变为 `10240MB`。

`web/src/components/file-tree/view/FileTreeHeader.tsx` 的 tooltip 模板 `Upload files (max {{size}} each)` 读 `MAX_FILE_UPLOAD_SIZE_LABEL`，随常量自动更新，**代码不改**（保持单一真源，不额外引入 `10GB` 人类可读变体）。

`web/src/components/file-tree/hooks/useFileTreeUpload.ts` 的 XHR + `upload.onprogress` 逻辑**完全不动**：它已是即时的传输进度，分片发生在后端，前端无感。

`web/src/components/chat/utils/fileAttachments.ts` 里的 `MAX_FILE_UPLOAD_SIZE = 50MB` 是**聊天附件**（`POST /api/assets/files`，≤50MB，见下）的独立常量，**不动**。

## 3. 后端 · 本机上传（含 2× 磁盘峰值修复）

现状（`index.js:1519-1536`）：multer `diskStorage` 把文件写到 `os.tmpdir()`，handler 里再 `copyFile` 到目标目录。10GB 文件会同时占用临时盘和目标盘，峰值 2×。

改为**目标目录内落地**：

1. multer 的 `destination` 回调改为目标目录下的临时目录 `<targetDir>/.lovdex-upload-<rand>/`，文件名保留原名（原始文件名仍在 `file.originalname`，folder 上传的 `relativePaths` 逻辑不变）。
2. multer 完成后，对每个文件把 `<tmpDir>/<name>` **`rename`** 到 `path.join(resolvedTargetDir, fileName)`——同盘原子操作，不再 `copyFile`。
3. 结束或失败时递归删除该临时目录（现有 catch / 清理点改指向它）。

注意 `targetDir` 只有在 handler 内解析（`relativePaths`、`validatePathInProject`）之后才确定，而 multer 的 `destination` 回调在解析之前，因此需要把「解析目标目录」提前到 multer 中间件之前（现在远程分支内部才解析）。本机与远程分支共用同一个已解析的 `resolvedTargetDir`。

## 4. 后端 · 远程上传（核心）

### 4.1 为什么是分片而不是别的

- 需保留：透明分流（前端零改动）、零新端口、无需 relay 出方向可达。
- 分片把「一次巨大的 base64 单帧」拆成「有序的一串小帧」，是对现有 `rpc_req` 帧协议与 `registry.rpc` 的**纯增量**扩展，不动协议二进制编码。
- 被否方案：
  - **二进制帧**：要拆掉 base64、让现有 WS 帧协议支持二进制，改动面大、风险高。
  - **lite HTTP + `ssh -L`**：真流式、能覆盖读回，但工作量数倍，`ssh -L` 还要新增隧道生命周期管理。

### 4.2 新增 RPC（`backend/server/shared/agent-runtime/protocol.ts` + lite `rpc-dispatch.ts`）

| 方法 | 参数 | 返回 |
|---|---|---|
| `fs/uploadBegin` | `{ path }` | `{ uploadId }` |
| `fs/uploadChunk` | `{ uploadId, index, data }`（`data` 为 base64） | `{ received }` |
| `fs/uploadEnd` | `{ uploadId }` | `{ success, size }` |

lite 侧实现放在 `backend/remote-agent/src/fs.ts` 内新增一个 `upload` 命名空间（与 `read/write` 同级），或独立 `upload-session.ts`。会话状态：

```
uploadId → { fd, targetPath, partPath, nextIndex, received, createdAt }
```

- `uploadBegin`：对目标路径做 `resolveWithinRoots` 白名单校验；在目标目录下创建 `.lovdex-upload-<uploadId>.part`，返回 `uploadId`。
- `uploadChunk`：`index` 必须**严格等于** `nextIndex`（拒绝乱序/重放）；`Buffer.from(data, 'base64')` 后 append 到 `.part`；`nextIndex++`、累加 `received`。
- `uploadEnd`：`fsync` → `rename` `.part` → 目标路径（原子）→ 删会话 → 返回 `{ success, size }`。
- 会话在**连接关闭**或**超时（如 10 分钟无分片）**时清理 `.part`（复用现有断连清理钩子 + 定时器）。

### 4.3 主侧分片循环

`index.js` 远程分支（现 `1616-1697`）：

1. 校验目标目录（沿用现有 `validatePathInProject` + 远程 `ensureRemoteParent`）。
2. 对 multer 落盘的每个临时文件：`fs/uploadBegin` → 分片读（read stream 或 `fs.read` 固定 buffer 循环，按 **4MiB** 切片）→ 逐片 `fs/uploadChunk`（`rpc` 默认 60s 超时足够；4MiB base64 ~5.33MiB）→ `fs/uploadEnd`。
3. 累计 size 与前端 `MAX_FILE_UPLOAD_SIZE_BYTES` 比对，超限 413。
4. 每个文件结束后删临时文件；失败则整批清理并返回错误。
5. 删除整段 base64 单帧逻辑与 `REMOTE_MAX_UPLOAD_BYTES` 引用（该常量从 `remote-fs.service.ts` 移除）。

**不会内存爆炸**：主侧任何时刻只持有一个 4MiB buffer；lite 侧 append 到 fd，也不整文件进内存。

### 4.4 远程读回维持 32MiB

`REMOTE_MAX_READ_BYTES` 与 lite `fs.ts:62` 的 `MAX_READ_BYTES_CAP` **都不改**，仍 32MiB。`files/content?path=` 远程分支遇 `truncated` 继续返回 413 `File too large to preview/download remotely (limit 32MB)`，文案准确。

`remote-adapters.ts` 的 `readFile`（>32MiB 抛 `ETOOBIG`）同样不动。

### 4.5 本会话不做的事（明确记录，避免被当成遗漏）

- **`POST /api/assets/files`（聊天附件，≤50MB）单文件上限不动**。`REMOTE_MAX_UPLOAD_BYTES` 被移除后，这个模块（`assets.routes.ts`）本来也不 import 它，无耦合。
- **远程大文件预览/下载不做**。故「上传 10GB 后无法在 UI 打开」是已知且接受的状态。
- **分片不落盘重试**。断网/刷新即失败，用户重传。

## 5. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 分片失败/连接断 | `uploadEnd` 未达 → 删 `.part`（主侧失败清理 + lite 断连/超时清理），整批报错 |
| 前端被绕过、真实超限 | 主侧累计 size 检查 → 413 |
| 目标路径逃逸 | `.part` 与目标都过 `resolveWithinRoots`；禁止穿透符号链接（复用 `write` 的 lstat 检查） |
| 乱序/重复分片 | lite 校验 `index === nextIndex`，不符即报错并清理 |
| 并发多文件 | `uploadId` 隔离，互不干扰 |
| 本机磁盘 | `destination` 改目标目录后峰值 1×；剩余 ~25G 盘，10GB 单文件可容 |

## 6. 测试

- **lite `fs.ts` upload 单测**：分片顺序、乱序拒绝、`uploadEnd` 原子改名、失败/超时清理 `.part`、路径白名单、符号链接拒绝。
- **主侧 `uploadFilesHandler` 远程分支单测**：假 `fsClient` 断言分片次数/大小/顺序；小文件落在单分片内。
- **loopback 集成测试**（`tests/loopback-lite.integration.test.ts`）扩一条：远程上传一个跨多分片的文件（注入缩小的分片阈值）。
- **常量测试**：`MAX_FILE_UPLOAD_SIZE_MB === 10240`（若已有断言则更新）。
- **验收基线**：tsc/lint 沿用「零新增」标准（见 [[lovdex-backend-baseline-not-clean]]）。
