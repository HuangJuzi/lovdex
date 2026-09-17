package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// setRoute pins a routing entry for a test and restores the previous table on
// cleanup so tests never leak route state into each other.
func setRoute(t *testing.T, alias, model, upstream string) {
	t.Helper()
	old := map[string]RouteEntry{}
	if routeTargets != nil {
		for k, v := range routeTargets {
			old[k] = v
		}
	}
	if routeTargets == nil {
		routeTargets = map[string]RouteEntry{}
	}
	routeTargets[alias] = RouteEntry{Model: model, Upstream: upstream}
	t.Cleanup(func() {
		if len(old) == 0 {
			routeTargets = nil
		} else {
			routeTargets = old
		}
	})
}

// withOpenAIUpstream points cfg.Upstream.OpenAIURL at a test server and restores
// the previous value on cleanup.
func withOpenAIUpstream(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	old := cfg.Upstream.OpenAIURL
	cfg.Upstream.OpenAIURL = srv.URL
	t.Cleanup(func() { cfg.Upstream.OpenAIURL = old })
	return srv
}

// ssePayloadsAll returns the data: JSON of every event whose event: label matches.
func ssePayloadsAll(stream, wantEvent string) []string {
	var curEvent, curData string
	var out []string
	for _, line := range strings.Split(stream, "\n") {
		if line == "" {
			if curEvent == wantEvent {
				out = append(out, curData)
			}
			curEvent, curData = "", ""
			continue
		}
		if strings.HasPrefix(line, "event:") {
			curEvent = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		}
		if strings.HasPrefix(line, "data:") {
			d := strings.TrimPrefix(line, "data:")
			if strings.HasPrefix(d, " ") {
				d = d[1:]
			}
			curData = d
		}
	}
	if curEvent == wantEvent {
		out = append(out, curData)
	}
	return out
}

// loadConfig must accept a [routing] entry shaped as { model, upstream = "openai" }
// for arbitrary aliases and keep the legacy string form for sonnet/opus/haiku.
func TestLoadConfigParsesOpenAIRoute(t *testing.T) {
	oldCfg := cfg
	oldRoutes := routeTargets
	t.Cleanup(func() { cfg = oldCfg; routeTargets = oldRoutes })

	path := filepath.Join(t.TempDir(), "config.toml")
	content := `[proxy]
port = 8088

[upstream]
anthropic_url = "https://www.sophnet.com/api/open-apis/anthropic"
openai_url = "https://api.sophnet.com/v1/chat/completions"

[keys]
sophnet = ""

[routing]
sonnet = "DeepSeek-V4-Flash-0731"
opus = "GLM-5.3"
flash = { model = "glm-5.3-flash", upstream = "openai" }
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LLM_PROXY_CONFIG", path)
	if err := loadConfig(); err != nil {
		t.Fatalf("loadConfig: %v", err)
	}

	if e := routeTargets["sonnet"]; e.Model != "DeepSeek-V4-Flash-0731" || e.Upstream != "" {
		t.Fatalf("legacy string route must stay anthropic, got %+v", e)
	}
	flash := routeTargets["flash"]
	if flash.Model != "glm-5.3-flash" || flash.Upstream != "openai" {
		t.Fatalf("table route must decode to openai target, got %+v", flash)
	}
	if e := routeTargets["haiku"]; e.Model != routeTargets["sonnet"].Model {
		t.Fatalf("haiku must default to sonnet target, got %+v", e)
	}
}

// A malformed routing entry must not abort config loading: it is skipped with a
// warning and the rest of the table survives.
func TestLoadConfigSkipsInvalidRoutingEntry(t *testing.T) {
	oldCfg := cfg
	t.Cleanup(func() { cfg = oldCfg })

	path := filepath.Join(t.TempDir(), "config.toml")
	content := `[routing]
sonnet = "DeepSeek-V4-Flash-0731"
flash = 42
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LLM_PROXY_CONFIG", path)
	if err := loadConfig(); err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if e := routeTargets["flash"]; e.Model != "" {
		t.Fatalf("invalid entry must be skipped, got %+v", e)
	}
	if e := routeTargets["sonnet"]; e.Model == "" {
		t.Fatal("valid entries must survive an invalid sibling")
	}
}

// routeTarget resolves: exact fixed keys via the legacy fields, custom aliases
// via the config table (exact match wins), and composed sonnet/opus/haiku names
// via substring matching like before.
func TestRouteTargetResolution(t *testing.T) {
	setRoute(t, "sonnet", "DeepSeek-V4-Flash-0731", "")
	setRoute(t, "opus", "GLM-5.3", "")
	setRoute(t, "haiku", "DeepSeek-V4-Flash-0731", "")
	setRoute(t, "flash", "glm-5.3-flash", "openai")
	setRoute(t, "main", "GLM-5.3", "")

	if tr := routeTarget("flash"); tr.Model != "glm-5.3-flash" || tr.Upstream != "openai" {
		t.Fatalf("custom alias route must win, got %+v", tr)
	}
	if tr := routeTarget("sonnet"); tr.Model != "DeepSeek-V4-Flash-0731" || tr.Upstream != "" {
		t.Fatalf("fixed key must resolve via legacy field, got %+v", tr)
	}
	if tr := routeTarget("main"); tr.Model != "GLM-5.3" {
		t.Fatalf("string table entry must decode, got %+v", tr)
	}
	if tr := routeTarget("claude-sonnet-4"); tr.Model != "DeepSeek-V4-Flash-0731" {
		t.Fatalf("composed name must match by substring, got %+v", tr)
	}
	if tr := routeTarget("unknown-model"); tr.Model != "" || tr.Upstream != "" {
		t.Fatalf("unknown model must passthrough untouched, got %+v", tr)
	}
}

// The builtin aliases (sonnet/opus/haiku) must accept table form exactly like
// custom aliases: `sonnet = { model = "glm-5.3-flash", upstream = "openai" }`
// routes the default Claude model to the OpenAI gateway. haiku (unset) inherits
// sonnet's full target including its upstream.
func TestLoadConfigParsesBuiltinAliasTableRoute(t *testing.T) {
	oldCfg := cfg
	oldRoutes := routeTargets
	t.Cleanup(func() { cfg = oldCfg; routeTargets = oldRoutes })

	path := filepath.Join(t.TempDir(), "config.toml")
	content := `[routing]
sonnet = { model = "glm-5.3-flash", upstream = "openai" }
opus = "GLM-5.3"
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LLM_PROXY_CONFIG", path)
	if err := loadConfig(); err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if tr := routeTarget("sonnet"); tr.Model != "glm-5.3-flash" || tr.Upstream != "openai" {
		t.Fatalf("table-form sonnet must route to the openai gateway, got %+v", tr)
	}
	if tr := routeTarget("haiku"); tr.Model != "glm-5.3-flash" || tr.Upstream != "openai" {
		t.Fatalf("haiku must inherit sonnet's target including upstream, got %+v", tr)
	}
	if tr := routeTarget("opus"); tr.Model != "GLM-5.3" || tr.Upstream != "" {
		t.Fatalf("string-form opus must stay on the anthropic gateway, got %+v", tr)
	}
}

// openAICompletionsURL must not double-append the path when the configured URL
// already carries the full /chat/completions endpoint.
func TestOpenAICompletionsURLNoDoubleAppend(t *testing.T) {
	old := cfg.Upstream.OpenAIURL
	t.Cleanup(func() { cfg.Upstream.OpenAIURL = old })

	cfg.Upstream.OpenAIURL = "https://api.sophnet.com/v1/chat/completions"
	if got := openAICompletionsURL(); got != "https://api.sophnet.com/v1/chat/completions" {
		t.Fatalf("full endpoint must be used as-is, got %q", got)
	}
	cfg.Upstream.OpenAIURL = "https://www.sophnet.com/api/open-apis/openai"
	if got := openAICompletionsURL(); got != "https://www.sophnet.com/api/open-apis/openai/v1/chat/completions" {
		t.Fatalf("base URL must get the path appended, got %q", got)
	}
}

// A plain-text Anthropic request must become an OpenAI request: system field to a
// system message, stop_sequences to stop, thinking dropped, model replaced.
func TestAnthropicToOpenAIRequestText(t *testing.T) {
	var req map[string]interface{}
	if err := json.Unmarshal([]byte(`{
		"model":"flash","max_tokens":2048,"temperature":0.5,
		"system":"你是一位助手",
		"stop_sequences":["stop here"],
		"stream":true,
		"messages":[
			{"role":"user","content":[{"type":"text","text":"你好"}]},
			{"role":"assistant","content":[{"type":"text","text":"你好！"}]}
		]
	}`), &req); err != nil {
		t.Fatal(err)
	}

	out := anthropicToOpenAIRequest(req, "glm-5.3-flash")

	if out["model"] != "glm-5.3-flash" {
		t.Fatalf("model must be replaced with the openai target, got %v", out["model"])
	}
	msgs, _ := out["messages"].([]interface{})
	if len(msgs) != 3 {
		t.Fatalf("expected system+user+assistant = 3 messages, got %d", len(msgs))
	}
	sys := msgs[0].(map[string]interface{})
	if sys["role"] != "system" || sys["content"] != "你是一位助手" {
		t.Fatalf("system field must become the first system message, got %+v", sys)
	}
	if out["max_tokens"] != float64(2048) || out["temperature"] != 0.5 || out["stream"] != true {
		t.Fatalf("scalar fields must be carried over: %v", out)
	}
	if out["stop"] == nil {
		t.Fatal("stop_sequences must map to stop")
	}
	if _, has := out["stop_sequences"]; has {
		t.Fatal("stop_sequences key must be renamed to stop")
	}
	if _, has := out["thinking"]; has {
		t.Fatal("thinking param must be dropped")
	}
	user := msgs[1].(map[string]interface{})
	if user["role"] != "user" || user["content"] != "你好" {
		t.Fatalf("text-only content must collapse to a string, got %+v", user)
	}
	assistant := msgs[2].(map[string]interface{})
	if assistant["role"] != "assistant" || assistant["content"] != "你好！" {
		t.Fatalf("assistant text must collapse to a string, got %+v", assistant)
	}
}

// An Anthropic image block must become an OpenAI image_url part with a data URL,
// and text siblings keep their order next to it.
func TestAnthropicToOpenAIRequestImage(t *testing.T) {
	var req map[string]interface{}
	if err := json.Unmarshal([]byte(`{
		"model":"flash","max_tokens":64,
		"messages":[{"role":"user","content":[
			{"type":"text","text":"看图"},
			{"type":"image","source":{"type":"base64","media_type":"image/png","data":"QUJD"}},
			{"type":"text","text":"描述它"}
		]}]
	}`), &req); err != nil {
		t.Fatal(err)
	}

	out := anthropicToOpenAIRequest(req, "glm-5.3-flash")
	msgs := out["messages"].([]interface{})
	content := msgs[0].(map[string]interface{})["content"].([]interface{})
	if len(content) != 3 {
		t.Fatalf("expected 3 content parts, got %d: %v", len(content), content)
	}
	img := content[1].(map[string]interface{})
	if img["type"] != "image_url" {
		t.Fatalf("image block must become image_url part, got %+v", img)
	}
	u := img["image_url"].(map[string]interface{})
	if u["url"] != "data:image/png;base64,QUJD" {
		t.Fatalf("image source must become a data URL, got %v", u["url"])
	}
}

// Tool calls must round-trip: tools → OpenAI function tools, tool_use → tool_calls,
// tool_result → role=tool message, thinking blocks stripped.
func TestAnthropicToOpenAIRequestTools(t *testing.T) {
	var req map[string]interface{}
	if err := json.Unmarshal([]byte(`{
		"model":"flash","max_tokens":64,
		"tools":[{"name":"bash","description":"运行命令","input_schema":{"type":"object","properties":{"command":{"type":"string"}}}}],
		"messages":[
			{"role":"assistant","content":[
				{"type":"thinking","thinking":"chain","signature":"sig"},
				{"type":"text","text":"我来运行"},
				{"type":"tool_use","id":"tu_1","name":"bash","input":{"command":"ls"}}
			]},
			{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":[{"type":"text","text":"ok"}]}]}
		]
	}`), &req); err != nil {
		t.Fatal(err)
	}

	out := anthropicToOpenAIRequest(req, "glm-5.3-flash")

	tools := out["tools"].([]interface{})
	t0 := tools[0].(map[string]interface{})
	if t0["type"] != "function" {
		t.Fatalf("anthropic tool must become an OpenAI function tool, got %+v", t0)
	}
	fn := t0["function"].(map[string]interface{})
	if fn["name"] != "bash" || fn["parameters"] == nil {
		t.Fatalf("function tool must carry name and parameters, got %+v", fn)
	}

	msgs := out["messages"].([]interface{})
	if len(msgs) != 2 {
		t.Fatalf("expected assistant + tool = 2 messages, got %d", len(msgs))
	}
	asst := msgs[0].(map[string]interface{})
	tcs := asst["tool_calls"].([]interface{})
	tc := tcs[0].(map[string]interface{})
	tfn := tc["function"].(map[string]interface{})
	if tc["id"] != "tu_1" || tfn["name"] != "bash" || tfn["arguments"] != `{"command":"ls"}` {
		t.Fatalf("tool_calls must carry id/name/arguments, got %+v", tc)
	}
	if asst["content"] != "我来运行" {
		t.Fatalf("assistant text must be preserved next to tool_calls, got %v", asst["content"])
	}
	tool := msgs[1].(map[string]interface{})
	if tool["role"] != "tool" || tool["tool_call_id"] != "tu_1" || tool["content"] != "ok" {
		t.Fatalf("tool_result must become a role=tool message, got %+v", tool)
	}
	if strings.Contains(string(mustJSON(t, out)), "thinking") {
		t.Fatal("thinking blocks must be stripped from the translated request")
	}
}

// mustJSON renders v as JSON, failing the test on error.
func mustJSON(t *testing.T, v interface{}) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json marshal: %v", err)
	}
	return b
}

// A non-streaming OpenAI completion must translate into an Anthropic message:
// content → content[] text block, usage and stop_reason mapped.
func TestOpenAIResponseToAnthropicText(t *testing.T) {
	body := `{"id":"chatcmpl-1","model":"glm-5.3-flash","choices":[{"index":0,"message":{"role":"assistant","content":"你好，我是 flash"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":6}}`
	out, err := openAIResponseToAnthropic([]byte(body))
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	var msg map[string]interface{}
	if err := json.Unmarshal(out, &msg); err != nil {
		t.Fatalf("output must be valid JSON: %v", err)
	}
	if msg["type"] != "message" || msg["role"] != "assistant" || msg["model"] != "glm-5.3-flash" {
		t.Fatalf("envelope fields wrong: %+v", msg)
	}
	if msg["stop_reason"] != "end_turn" {
		t.Fatalf("stop must map to end_turn, got %v", msg["stop_reason"])
	}
	content := msg["content"].([]interface{})
	if len(content) != 1 {
		t.Fatalf("expected 1 content block, got %d: %v", len(content), content)
	}
	blk := content[0].(map[string]interface{})
	if blk["type"] != "text" || blk["text"] != "你好，我是 flash" {
		t.Fatalf("text block wrong: %+v", blk)
	}
	usage := msg["usage"].(map[string]interface{})
	if usage["input_tokens"] != float64(12) || usage["output_tokens"] != float64(6) {
		t.Fatalf("usage must map prompt/completion tokens, got %+v", usage)
	}
}

// OpenAI tool_calls must become Anthropic tool_use content blocks with parsed
// input, and finish_reason=tool_calls must map to stop_reason=tool_use.
func TestOpenAIResponseToAnthropicToolUse(t *testing.T) {
	body := `{"id":"chatcmpl-2","model":"glm-5.3-flash","choices":[{"index":0,"message":{"role":"assistant","content":"我来运行","tool_calls":[{"id":"call_1","type":"function","function":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":9}}`
	out, err := openAIResponseToAnthropic([]byte(body))
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	var msg map[string]interface{}
	json.Unmarshal(out, &msg)
	if msg["stop_reason"] != "tool_use" {
		t.Fatalf("tool_calls must map to stop_reason tool_use, got %v", msg["stop_reason"])
	}
	content := msg["content"].([]interface{})
	if len(content) != 2 {
		t.Fatalf("expected text + tool_use blocks, got %d: %v", len(content), content)
	}
	var tu map[string]interface{}
	for _, b := range content {
		if b.(map[string]interface{})["type"] == "tool_use" {
			tu = b.(map[string]interface{})
		}
	}
	if tu == nil {
		t.Fatal("tool_use block missing")
	}
	if tu["id"] != "call_1" || tu["name"] != "bash" {
		t.Fatalf("tool_use must carry id and name, got %+v", tu)
	}
	input, ok := tu["input"].(map[string]interface{})
	if !ok || input["command"] != "ls" {
		t.Fatalf("arguments JSON string must be parsed into an input object, got %+v", tu["input"])
	}
}

// An upstream error body must be translated into the Anthropic error envelope
// with the HTTP status semantics preserved.
func TestOpenAIErrorTranslated(t *testing.T) {
	errJSON := translateOpenAIError(400, []byte(`{"error":{"message":"model not found","type":"invalid_request_error","code":"invalid_api_key"}}`))
	var e map[string]interface{}
	if err := json.Unmarshal(errJSON, &e); err != nil {
		t.Fatalf("error body must be JSON: %v", err)
	}
	if e["type"] != "error" {
		t.Fatalf("envelope type must be error, got %+v", e)
	}
	ee := e["error"].(map[string]interface{})
	if ee["type"] != "invalid_request_error" || ee["message"] != "model not found" {
		t.Fatalf("error fields wrong: %+v", ee)
	}

	rate := translateOpenAIError(429, []byte(`{"error":{"message":"rate limited"}}`))
	var r map[string]interface{}
	json.Unmarshal(rate, &r)
	re := r["error"].(map[string]interface{})
	if re["type"] != "rate_limit_error" {
		t.Fatalf("429 must map to rate_limit_error, got %v", re["type"])
	}

	svc := translateOpenAIError(502, []byte("bad gateway"))
	var s map[string]interface{}
	json.Unmarshal(svc, &s)
	se := s["error"].(map[string]interface{})
	if se["type"] != "api_error" || se["message"] == "" {
		t.Fatalf("5xx must map to api_error with a message, got %+v", se)
	}
}

const openAITextChunks = `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"你"},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
`

// An OpenAI streaming chunk sequence must become a full Anthropic event stream:
// message_start → content_block_start → text deltas → message_delta → message_stop.
func TestTranslateOpenAIStreamText(t *testing.T) {
	var buf strings.Builder
	translateOpenAIStream(strings.NewReader(openAITextChunks), &buf, "glm-5.3-flash")

	out := buf.String()
	// Every data: line in the output must belong to an event block (preceded by
	// an event: line) — raw OpenAI chunk lines would leak without a label.
	lines := strings.Split(out, "\n")
	for i, ln := range lines {
		if strings.HasPrefix(ln, "data:") {
			if i == 0 || !strings.HasPrefix(lines[i-1], "event:") {
				t.Fatalf("raw OpenAI data line leaked without an event label: %q", ln)
			}
		}
	}
	if p := ssePayloadsAll(out, "message_start"); len(p) != 1 || !strings.Contains(p[0], `"model":"glm-5.3-flash"`) {
		t.Fatalf("message_start must carry the openai model, got %v", p)
	}
	deltas := ssePayloadsAll(out, "content_block_delta")
	if len(deltas) != 2 {
		t.Fatalf("expected 2 text deltas, got %d: %s", len(deltas), out)
	}
	if !strings.Contains(deltas[0], `"你"`) || !strings.Contains(deltas[1], `"好"`) {
		t.Fatalf("text deltas must carry the streamed text, got %v", deltas)
	}
	if p := ssePayloadsAll(out, "message_delta"); len(p) != 1 || !strings.Contains(p[0], `"stop_reason":"end_turn"`) {
		t.Fatalf("message_delta must carry the mapped stop_reason, got %v", p)
	}
	if len(ssePayloadsAll(out, "message_stop")) != 1 {
		t.Fatalf("exactly one message_stop expected")
	}
	// Control-flow order must be preserved.
	order := []string{"message_start", "content_block_start", "content_block_delta", "message_delta", "message_stop"}
	prev := -1
	for _, ev := range order {
		idx := strings.Index(out, "event: "+ev)
		if idx < 0 || idx < prev {
			t.Fatalf("event %q out of order in: %s", ev, out)
		}
		prev = idx
	}
}

const openAIToolChunks = `data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"正在调用工具"},"finish_reason":null}]}

data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"bash","arguments":""}}]},"finish_reason":null}]}

data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"cmd\":\"ls\"}"}}]},"finish_reason":null}]}

data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
`

// A streaming tool call must surface as an Anthropic tool_use block: block start
// with id/name, input_json_delta deltas, and stop_reason tool_use.
func TestTranslateOpenAIStreamToolCall(t *testing.T) {
	var buf strings.Builder
	translateOpenAIStream(strings.NewReader(openAIToolChunks), &buf, "glm-5.3-flash")

	out := buf.String()
	starts := ssePayloadsAll(out, "content_block_start")
	if len(starts) != 2 {
		t.Fatalf("expected text + tool_use block starts, got %d: %s", len(starts), out)
	}
	var toolStart string
	for _, s := range starts {
		if strings.Contains(s, `"type":"tool_use"`) {
			toolStart = s
		}
	}
	if toolStart == "" {
		t.Fatalf("tool_use block start missing: %s", out)
	}
	if !strings.Contains(toolStart, `"id":"call_9"`) || !strings.Contains(toolStart, `"name":"bash"`) {
		t.Fatalf("tool_use start must carry id and name, got %s", toolStart)
	}
	deltas := ssePayloadsAll(out, "content_block_delta")
	hasJSONDelta := false
	for _, d := range deltas {
		if strings.Contains(d, `"input_json_delta"`) && strings.Contains(d, `"{\"cmd\":\"ls\"}"`) {
			hasJSONDelta = true
		}
	}
	if !hasJSONDelta {
		t.Fatalf("tool arguments must stream as input_json_delta, got %v", deltas)
	}
	if p := ssePayloadsAll(out, "message_delta"); len(p) != 1 || !strings.Contains(p[0], `"stop_reason":"tool_use"`) {
		t.Fatalf("finish_reason must map to stop_reason tool_use, got %v", p)
	}
	if len(ssePayloadsAll(out, "message_stop")) != 1 {
		t.Fatal("exactly one message_stop expected")
	}
}

// A stream that ends without a finish_reason (e.g. only [DONE]) must still close
// every open block and terminate with message_delta + message_stop.
func TestTranslateOpenAIStreamClosesWithoutFinishReason(t *testing.T) {
	chunks := `data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}

data: [DONE]
`
	var buf strings.Builder
	translateOpenAIStream(strings.NewReader(chunks), &buf, "glm-5.3-flash")
	out := buf.String()
	if len(ssePayloadsAll(out, "message_delta")) != 1 {
		t.Fatalf("message_delta must be emitted even without finish_reason: %s", out)
	}
	if len(ssePayloadsAll(out, "message_stop")) != 1 {
		t.Fatalf("message_stop must be emitted even without finish_reason: %s", out)
	}
}

// An upstream error chunk inside a stream must surface as an Anthropic error event.
func TestTranslateOpenAIStreamErrorChunk(t *testing.T) {
	chunks := `data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}

data: {"error":{"message":"upstream exploded"}}

data: [DONE]
`
	var buf strings.Builder
	translateOpenAIStream(strings.NewReader(chunks), &buf, "glm-5.3-flash")
	out := buf.String()
	if p := ssePayloadsAll(out, "error"); len(p) != 1 || !strings.Contains(p[0], "upstream exploded") {
		t.Fatalf("error chunk must become an error event, got %s", out)
	}
}

// End to end: a request named "flash" hitting the openai route must reach the
// OpenAI upstream in OpenAI format and come back as an Anthropic message.
func TestE2EOpenAIRouteNonStream(t *testing.T) {
	setRoute(t, "flash", "glm-5.3-flash", "openai")

	var upstreamBody string
	var mu sync.Mutex
	withOpenAIUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		upstreamBody = string(b)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"chatcmpl-9","model":"glm-5.3-flash","choices":[{"index":0,"message":{"role":"assistant","content":"你好，我是 flash"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":6}}`)
	})

	resp := callHandleMessages(t, `{"model":"flash","max_tokens":100,"system":"你是一位助手","messages":[{"role":"user","content":"你好"}]}`)

	mu.Lock()
	body := upstreamBody
	mu.Unlock()
	var sent map[string]interface{}
	if err := json.Unmarshal([]byte(body), &sent); err != nil {
		t.Fatalf("upstream must receive valid JSON: %v", err)
	}
	if sent["model"] != "glm-5.3-flash" {
		t.Fatalf("upstream model must be the openai target, got %v", sent["model"])
	}
	msgs := sent["messages"].([]interface{})
	sys := msgs[0].(map[string]interface{})
	if sys["role"] != "system" || sys["content"] != "你是一位助手" {
		t.Fatalf("upstream request must carry the system message, got %+v", sys)
	}
	if strings.Contains(body, `"/v1/messages"`) || strings.Contains(body, `"anthropic-version"`) {
		t.Fatalf("request must be OpenAI format, got: %s", body)
	}

	var msg map[string]interface{}
	if err := json.Unmarshal([]byte(resp), &msg); err != nil {
		t.Fatalf("client must receive valid JSON: %v\nresp=%s", err, resp)
	}
	if msg["type"] != "message" {
		t.Fatalf("client must receive an anthropic message, got %+v", msg)
	}
	content := msg["content"].([]interface{})
	blk := content[0].(map[string]interface{})
	if blk["text"] != "你好，我是 flash" {
		t.Fatalf("translated reply text wrong: %+v", content)
	}
}

// End to end: streaming through the openai route must surface as Anthropic SSE
// events that Claude Code can consume.
func TestE2EOpenAIRouteStreaming(t *testing.T) {
	setRoute(t, "flash", "glm-5.3-flash", "openai")

	withOpenAIUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		f, _ := w.(http.Flusher)
		for _, ln := range []string{
			`data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"你"},"finish_reason":null}]}`,
			`data: {"id":"c1","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}`,
			`data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
			`data: [DONE]`,
		} {
			io.WriteString(w, ln+"\n\n")
			f.Flush()
		}
	})

	resp := callHandleMessages(t, `{"model":"flash","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"你好"}]}`)

	if !strings.Contains(resp, "event: message_start") {
		t.Fatalf("stream must open with message_start, got: %s", resp)
	}
	if p := ssePayloadsAll(resp, "content_block_delta"); len(p) != 2 || !strings.Contains(p[0], "你") {
		t.Fatalf("text deltas missing from the stream, got: %s", resp)
	}
	if len(ssePayloadsAll(resp, "message_stop")) != 1 {
		t.Fatalf("stream must end with exactly one message_stop, got: %s", resp)
	}
}

// End to end: an upstream 400 must pass through as an Anthropic error with the
// same status, not get mangled into a success.
func TestE2EOpenAIErrorPassthrough(t *testing.T) {
	setRoute(t, "flash", "glm-5.3-flash", "openai")

	withOpenAIUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		io.WriteString(w, `{"error":{"message":"model not found","type":"invalid_request_error"}}`)
	})

	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{"model":"flash","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}`))
	w := httptest.NewRecorder()
	handleMessages(w, req)
	res := w.Result()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 400 {
		t.Fatalf("upstream 400 must stay 400, got %d", res.StatusCode)
	}
	var e map[string]interface{}
	if err := json.Unmarshal(body, &e); err != nil {
		t.Fatalf("error body must be JSON: %v, got %s", err, body)
	}
	ee := e["error"].(map[string]interface{})
	if ee["type"] != "invalid_request_error" || ee["message"] != "model not found" {
		t.Fatalf("error envelope wrong: %+v", ee)
	}
}

// The sonnet route must keep using the Anthropic gateway untouched (regression):
// the openai branch only fires for routes marked upstream=openai.
func TestSonnetRouteStillUsesAnthropicGateway(t *testing.T) {
	setRoute(t, "flash", "glm-5.3-flash", "openai")
	setRoute(t, "sonnet", "DeepSeek-V4-Flash-0731", "")

	got := modelSentToUpstream(t, `{"model":"sonnet","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`)
	if got != "DeepSeek-V4-Flash-0731" {
		t.Fatalf("sonnet must still route through the anthropic gateway, upstream received %q", got)
	}
}
