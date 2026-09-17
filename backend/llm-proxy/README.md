# llm-proxy (vendored + maintained in Lovdex)

Anthropic 透明代理 sidecar：把 Claude Code 的 `/v1/messages` 请求转发到上游（sophnet），做模型路由、Anthropic↔OpenAI 协议互译、VLM 图片先描述，并修复一组第三方 Anthropic 兼容上游（DeepSeek 系）的流式报错。

## 来源与归属

- **forked from** [`zzttzzmyswy/llm-proxy`](https://github.com/zzttzzmyswy/llm-proxy)（MIT，见 `LICENSE`）。
- 源码已 **vendor 进 Lovdex 并由此处直接维护**：本目录不是只读快照，服务有 bug 就在这里改，不等上游。改完用本目录的 `go test ./...` 验证。

## 构建与测试

```bash
go build -o llm-proxy .          # 或 ./build.sh
go test ./...                    # 无需预置 /etc/llm-proxy/config.toml，suite 是 hermetic 的
```

> `go.mod` 声明 `go 1.26.5`；Go 工具链会自动下载该版本 + `github.com/BurntSushi/toml` 依赖。离线部署机需提前缓存工具链/依赖，或改用 prebuilt 二进制。

## 运行方式

Lovdex 后端在启动时（`server/modules/llm-proxy/manager.ts`）从 `app.config.json` 的 `llmProxy` 段生成 TOML 到 `<dataDir>/llm-proxy.toml`，并以环境变量驱动本二进制：

- `LLM_PROXY_CONFIG` → TOML 路径
- `SOPHNET_API_KEY` → 上游密钥（复用 `providers.claude.apiKey`）

上游 URL、模型路由、VLM 参数都从 `config.example.toml` 的同名结构派生（详见 `generateToml`）。

**模型路由语义**：只做**精确别名匹配**（`sonnet`/`opus`/`haiku`/自定义别名 → 上游模型）；不在 `[routing]` 里的名字**原样透传**，不做子串匹配——Lovdex 由 claude CLI 侧 `ANTHROPIC_DEFAULT_*_MODEL` 解析出具体模型名（如 `claude-opus-4-8`），代理若按子串把它重路由到 `opus` 目标会跑错模型（已修）。

## 报错修复能力（本目录职责所在）

- SSE 缺 `message_stop` 补帧
- 损坏 thinking 块规范化（`thinking` 字段缺失补空串 + `signature` 清空）
- 空响应发 `error` SSE 事件触发重试
- thinking 400 "must be passed back" 逐级重试
- 图片 400 "do not support image" 回退 VLM
- 禁用 gzip、180s 响应头超时

修复/新增能力时，先在 `main_test.go` / `translation_test.go` 里补用例（它们 mock 上游，纯内存可跑），再改 `main.go`。
