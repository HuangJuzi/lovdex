package main

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

// buildSSE turns (event, dataJSON) pairs into a raw SSE byte stream.
func buildSSE(events [][2]string) []byte {
	var buf bytes.Buffer
	for _, e := range events {
		buf.WriteString("event: " + e[0] + "\n")
		buf.WriteString("data: " + e[1] + "\n\n")
	}
	return buf.Bytes()
}

// collectEvents drains the rewriter output back into (event, data) pairs.
func collectEvents(t *testing.T, r io.Reader) [][2]string {
	t.Helper()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read rewriter output: %v", err)
	}
	var events [][2]string
	for _, block := range strings.Split(string(out), "\n\n") {
		if block == "" {
			continue
		}
		var ev, data string
		for _, line := range strings.Split(block, "\n") {
			if strings.HasPrefix(line, "event: ") {
				ev = strings.TrimPrefix(line, "event: ")
			} else if strings.HasPrefix(line, "data: ") {
				data = strings.TrimPrefix(line, "data: ")
			}
		}
		events = append(events, [2]string{ev, data})
	}
	return events
}

func usageOf(t *testing.T, data string) map[string]interface{} {
	t.Helper()
	var ev struct {
		Message map[string]interface{} `json:"message"`
		Usage   map[string]interface{} `json:"usage"`
	}
	if err := json.Unmarshal([]byte(data), &ev); err != nil {
		t.Fatalf("parse event data %q: %v", data, err)
	}
	if ev.Usage != nil {
		return ev.Usage
	}
	if ev.Message != nil {
		if u, ok := ev.Message["usage"].(map[string]interface{}); ok {
			return u
		}
	}
	t.Fatalf("no usage object in %q", data)
	return nil
}

// The gateway's inclusive reply (adopted 2026-09-24): input_tokens counts the
// cached tokens inside it, cache_read mirrors prompt_tokens_details.cached_tokens,
// and billing_usage / claude_cache_creation_* mark the translator. The rewrite
// must turn it into Anthropic exclusive semantics.
func TestUsageNormalizeInclusiveMessageDelta(t *testing.T) {
	in := buildSSE([][2]string{
		{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"billing_usage":{"semantic":"openai"},"claude_cache_creation_5_m_tokens":0,"input_tokens":11274,"cache_read_input_tokens":11136,"cache_creation_input_tokens":0,"output_tokens":4124}}`},
	})
	events := collectEvents(t, newResponseRewriter(bytes.NewReader(in), nil))
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	u := usageOf(t, events[0][1])
	if got := int(u["input_tokens"].(float64)); got != 11274-11136 {
		t.Fatalf("input_tokens must be fresh-only (11274-11136=138), got %d", got)
	}
	if got := int(u["cache_read_input_tokens"].(float64)); got != 11136 {
		t.Fatalf("cache_read_input_tokens must keep the cached count, got %d", got)
	}
}

// message_start carries usage under message.usage — the rewrite must reach it too.
func TestUsageNormalizeInclusiveMessageStart(t *testing.T) {
	in := buildSSE([][2]string{
		{"message_start", `{"type":"message_start","message":{"id":"msg_x","usage":{"billing_usage":{"semantic":"openai"},"claude_cache_creation_5_m_tokens":0,"input_tokens":11262,"cache_read_input_tokens":11264,"cache_creation_input_tokens":0,"output_tokens":0}}}`},
	})
	events := collectEvents(t, newResponseRewriter(bytes.NewReader(in), nil))
	u := usageOf(t, events[0][1])
	// input < cached here (11262 < 11264): inclusive semantics cannot produce
	// that shape, so the conservative guard must leave the event verbatim…
	if _, ok := u["input_tokens"]; !ok {
		t.Fatalf("usage object lost input_tokens: %v", u)
	}
	// …unless the numbers say inclusive. This fixture has input<cached on
	// purpose: assert passthrough.
	if got := int(u["input_tokens"].(float64)); got != 11262 {
		t.Fatalf("exclusive-looking usage must pass through verbatim, got input=%d", got)
	}
}

// Legacy exclusive replies (pre-2026-09-24, still interleaved after): input
// excludes the cache read, so input < cached holds. These carry no translator
// markers and must never be rewritten.
func TestUsageNormalizeExclusivePassthrough(t *testing.T) {
	in := buildSSE([][2]string{
		{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":139,"cache_read_input_tokens":11136,"cache_creation_input_tokens":0,"output_tokens":4124,"service_tier":"standard"}}`},
	})
	events := collectEvents(t, newResponseRewriter(bytes.NewReader(in), nil))
	u := usageOf(t, events[0][1])
	if got := int(u["input_tokens"].(float64)); got != 139 {
		t.Fatalf("exclusive usage must pass through, got input=%d", got)
	}
}

// Cache miss (cached=0): nothing to subtract, keep verbatim.
func TestUsageNormalizeColdMissUntouched(t *testing.T) {
	raw := `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"billing_usage":{"semantic":"openai"},"claude_cache_creation_5_m_tokens":0,"input_tokens":4043,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":2}}`
	in := buildSSE([][2]string{{"message_delta", raw}})
	events := collectEvents(t, newResponseRewriter(bytes.NewReader(in), nil))
	if events[0][1] != raw {
		t.Fatalf("cold-miss usage must pass through verbatim:\n in: %s\ngot: %s", raw, events[0][1])
	}
}

// thinking-block normalization (the pre-existing rewrite) must keep working
// alongside the usage rewrite.
func TestThinkingRewriteStillFires(t *testing.T) {
	in := buildSSE([][2]string{
		{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"thinking","signature":"bogus"}}`},
	})
	events := collectEvents(t, newResponseRewriter(bytes.NewReader(in), nil))
	if !strings.Contains(events[0][1], `"thinking":""`) {
		t.Fatalf("thinking block must be normalized, got %s", events[0][1])
	}
}

// Non-streaming replies get the same treatment via normalizeNonStreamUsage.
func TestNonStreamUsageNormalize(t *testing.T) {
	body := `{"id":"msg_1","type":"message","role":"assistant","model":"DeepSeek-Flash","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"billing_usage":{"semantic":"openai"},"claude_cache_creation_5_m_tokens":0,"input_tokens":1671,"cache_read_input_tokens":1536,"cache_creation_input_tokens":0,"output_tokens":2}}`
	r, err := normalizeNonStreamUsage(bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatalf("normalizeNonStreamUsage: %v", err)
	}
	out, _ := io.ReadAll(r)
	var m struct {
		Usage struct {
			Input     int `json:"input_tokens"`
			CacheRead int `json:"cache_read_input_tokens"`
			Output    int `json:"output_tokens"`
		} `json:"usage"`
		Content []map[string]interface{} `json:"content"`
	}
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("parse normalized body: %v\n%s", err, out)
	}
	if m.Usage.Input != 1671-1536 {
		t.Fatalf("input_tokens must be fresh-only, got %d", m.Usage.Input)
	}
	if m.Usage.CacheRead != 1536 {
		t.Fatalf("cache_read must survive, got %d", m.Usage.CacheRead)
	}
	if len(m.Content) != 1 || m.Content[0]["text"] != "ok" {
		t.Fatalf("content must pass through untouched: %v", m.Content)
	}
}

// Regression for the first version of the fix: normalizeUsageEvent parsed the
// event into a struct holding only message/usage, so a rewritten message_delta
// lost type / delta / stop_reason — end-to-end Claude Code runs then reported
// stop_reason:null and an empty modelUsage. The rewrite must keep the envelope.
func TestUsageNormalizePreservesMessageDeltaEnvelope(t *testing.T) {
	in := buildSSE([][2]string{
		{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"billing_usage":{"semantic":"openai"},"claude_cache_creation_5_m_tokens":0,"input_tokens":11274,"cache_read_input_tokens":11136,"cache_creation_input_tokens":0,"output_tokens":4124}}`},
	})
	events := collectEvents(t, newResponseRewriter(bytes.NewReader(in), nil))
	var ev struct {
		Type  string `json:"type"`
		Delta struct {
			StopReason string `json:"stop_reason"`
		} `json:"delta"`
		Usage struct {
			Input int `json:"input_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal([]byte(events[0][1]), &ev); err != nil {
		t.Fatalf("parse rewritten event: %v\n%s", err, events[0][1])
	}
	if ev.Type != "message_delta" {
		t.Fatalf("envelope type lost: %s", events[0][1])
	}
	if ev.Delta.StopReason != "tool_use" {
		t.Fatalf("delta.stop_reason lost: %s", events[0][1])
	}
	if ev.Usage.Input != 11274-11136 {
		t.Fatalf("input_tokens must be fresh-only, got %d", ev.Usage.Input)
	}
}

// message_start keeps its message envelope (id, model, role) through the rewrite.
func TestUsageNormalizePreservesMessageStartEnvelope(t *testing.T) {
	in := buildSSE([][2]string{
		{"message_start", `{"type":"message_start","message":{"id":"msg_abc","type":"message","role":"assistant","model":"DeepSeek-Flash","content":[],"stop_reason":null,"usage":{"billing_usage":{"semantic":"openai"},"claude_cache_creation_5_m_tokens":0,"input_tokens":3375,"cache_read_input_tokens":3328,"cache_creation_input_tokens":0,"output_tokens":1}}}`},
	})
	events := collectEvents(t, newResponseRewriter(bytes.NewReader(in), nil))
	var ev struct {
		Type    string `json:"type"`
		Message struct {
			ID    string `json:"id"`
			Model string `json:"model"`
			Usage struct {
				Input     int `json:"input_tokens"`
				CacheRead int `json:"cache_read_input_tokens"`
			} `json:"usage"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(events[0][1]), &ev); err != nil {
		t.Fatalf("parse rewritten event: %v\n%s", err, events[0][1])
	}
	if ev.Type != "message_start" || ev.Message.ID != "msg_abc" || ev.Message.Model != "DeepSeek-Flash" {
		t.Fatalf("message_start envelope lost: %s", events[0][1])
	}
	if ev.Message.Usage.Input != 3375-3328 {
		t.Fatalf("input_tokens must be fresh-only, got %d", ev.Message.Usage.Input)
	}
	if ev.Message.Usage.CacheRead != 3328 {
		t.Fatalf("cache_read must survive, got %d", ev.Message.Usage.CacheRead)
	}
}

// freshPrompt clamps: cached >= prompt must not go negative.
func TestFreshPromptClamp(t *testing.T) {
	if got := freshPrompt(100, 0); got != 100 {
		t.Fatalf("freshPrompt(100,0)=%d, want 100", got)
	}
	if got := freshPrompt(100, 100); got != 0 {
		t.Fatalf("freshPrompt(100,100)=%d, want 0", got)
	}
	if got := freshPrompt(100, 150); got != 0 {
		t.Fatalf("freshPrompt(100,150)=%d, want 0 (clamped)", got)
	}
	if got := freshPrompt(11274, 11136); got != 138 {
		t.Fatalf("freshPrompt(11274,11136)=%d, want 138", got)
	}
}
