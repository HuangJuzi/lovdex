package main

import (
	"io"
	"strings"
	"testing"
)

func sse(parts ...string) string { return strings.Join(parts, "") }

func ev(event, data string) string {
	return "event: " + event + "\ndata: " + data + "\n\n"
}

func runRewriter(t *testing.T, req map[string]interface{}, stream string) string {
	t.Helper()
	lr := newLeakRewriter(req)
	out, err := io.ReadAll(newResponseRewriter(strings.NewReader(stream), lr))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(out)
}

func tools(names ...string) map[string]interface{} {
	ts := make([]interface{}, 0, len(names))
	for _, n := range names {
		ts = append(ts, map[string]interface{}{"name": n})
	}
	return map[string]interface{}{"tools": ts}
}

// 纯 <invoke> 泄漏 → 改写为 tool_use block，复用 index，XML 不再展示给用户。
func TestLeakRewriterConvertsInvokeToToolUse(t *testing.T) {
	req := tools("Bash")
	stream := sse(
		ev("message_start", `{"type":"message_start"}`),
		ev("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`),
		ev("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<invoke name=\"Bash\"><parameter name=\"command\">ls</parameter></invoke>"}}`),
		ev("content_block_stop", `{"type":"content_block_stop","index":0}`),
		ev("message_stop", `{"type":"message_stop"}`),
	)
	out := runRewriter(t, req, stream)
	if !strings.Contains(out, `"type":"tool_use"`) {
		t.Fatalf("should emit tool_use, got:\n%s", out)
	}
	if !strings.Contains(out, `"name":"Bash"`) {
		t.Fatalf("tool_use name should be Bash, got:\n%s", out)
	}
	if !strings.Contains(out, `command`) || !strings.Contains(out, `ls`) {
		t.Fatalf("input should contain command=ls, got:\n%s", out)
	}
	if strings.Contains(out, "<invoke") {
		t.Fatalf("leaked XML must be stripped, got:\n%s", out)
	}
}

// 正常文本必须原样透传，不被改写。
func TestLeakRewriterPassesNormalText(t *testing.T) {
	req := tools("Bash")
	stream := sse(
		ev("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`),
		ev("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello world"}}`),
		ev("content_block_stop", `{"type":"content_block_stop","index":0}`),
	)
	out := runRewriter(t, req, stream)
	if !strings.Contains(out, "hello world") {
		t.Fatalf("normal text should pass through, got:\n%s", out)
	}
	if strings.Contains(out, "tool_use") {
		t.Fatalf("normal text must not become tool_use, got:\n%s", out)
	}
}

// name 不在白名单 → 不当工具调用，整段当正常文本回放。
func TestLeakRewriterIgnoresUnknownTool(t *testing.T) {
	req := tools("Bash")
	stream := sse(
		ev("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`),
		ev("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<invoke name=\"NoSuchTool\"></invoke>"}}`),
		ev("content_block_stop", `{"type":"content_block_stop","index":0}`),
	)
	out := runRewriter(t, req, stream)
	if strings.Contains(out, "tool_use") {
		t.Fatalf("unknown tool must not be converted, got:\n%s", out)
	}
}

// 请求未声明任何 tools → 不拦截任何内容。
func TestLeakRewriterNoToolsNoIntercept(t *testing.T) {
	req := map[string]interface{}{}
	stream := sse(
		ev("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`),
		ev("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<invoke name=\"Bash\"></invoke>"}}`),
		ev("content_block_stop", `{"type":"content_block_stop","index":0}`),
	)
	out := runRewriter(t, req, stream)
	if strings.Contains(out, "tool_use") {
		t.Fatalf("must not intercept without tools declaration, got:\n%s", out)
	}
}

// OpenAI 兼容层风格 <tool_call> JSON → 改写为 tool_use。
func TestLeakRewriterConvertsToolCallJSON(t *testing.T) {
	req := tools("get_weather")
	stream := sse(
		ev("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`),
		ev("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<tool_call name=\"get_weather\">{\"location\":\"beijing\"}</tool_call>"}}`),
		ev("content_block_stop", `{"type":"content_block_stop","index":0}`),
	)
	out := runRewriter(t, req, stream)
	if !strings.Contains(out, `"type":"tool_use"`) {
		t.Fatalf("should emit tool_use for <tool_call>, got:\n%s", out)
	}
	if !strings.Contains(out, `"name":"get_weather"`) {
		t.Fatalf("tool_use name should be get_weather, got:\n%s", out)
	}
	if !strings.Contains(out, `location`) || !strings.Contains(out, `beijing`) {
		t.Fatalf("input should contain location, got:\n%s", out)
	}
}

// 跨 delta 的泄漏：XML 被拆成多个 text_delta，仍应整体识别并转换。
func TestLeakRewriterHandlesSplitDeltas(t *testing.T) {
	req := tools("Bash")
	stream := sse(
		ev("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`),
		ev("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<invoke name=\"Bash\"><para"}}`),
		ev("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"meter name=\"command\">ls</parameter></invoke>"}}`),
		ev("content_block_stop", `{"type":"content_block_stop","index":0}`),
	)
	out := runRewriter(t, req, stream)
	if !strings.Contains(out, `"type":"tool_use"`) {
		t.Fatalf("should emit tool_use for split deltas, got:\n%s", out)
	}
	if !strings.Contains(out, `command`) || !strings.Contains(out, `ls`) {
		t.Fatalf("input should contain command=ls, got:\n%s", out)
	}
	if strings.Contains(out, "<invoke") {
		t.Fatalf("leaked XML must be stripped, got:\n%s", out)
	}
}

// 带 string="true" 属性的 parameter（真实泄漏形态，见实测样本）。
func TestLeakRewriterConvertsInvokeWithStringAttr(t *testing.T) {
	req := tools("Bash")
	stream := sse(
		ev("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`),
		ev("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<invoke name=\"Bash\"><parameter name=\"command\">ls</parameter><parameter name=\"description\" string=\"true\">desc</parameter></invoke>"}}`),
		ev("content_block_stop", `{"type":"content_block_stop","index":0}`),
	)
	out := runRewriter(t, req, stream)
	if !strings.Contains(out, `"type":"tool_use"`) {
		t.Fatalf("should emit tool_use, got:\n%s", out)
	}
	if !strings.Contains(out, `command`) || !strings.Contains(out, `ls`) {
		t.Fatalf("should parse command param, got:\n%s", out)
	}
	if !strings.Contains(out, `description`) || !strings.Contains(out, `desc`) {
		t.Fatalf("should parse description param, got:\n%s", out)
	}
}
