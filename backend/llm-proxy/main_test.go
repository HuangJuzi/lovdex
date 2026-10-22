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

func withUpstreamCapture(t *testing.T, contentType, body string, capture func(*http.Request)) *httptest.Server {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if capture != nil {
			capture(r)
		}
		w.Header().Set("Content-Type", contentType)
		io.WriteString(w, body)
	}))
	t.Cleanup(upstream.Close)

	oldURL := cfg.Upstream.AnthropicURL
	cfg.Upstream.AnthropicURL = upstream.URL
	t.Cleanup(func() { cfg.Upstream.AnthropicURL = oldURL })
	return upstream
}

// modelSentToUpstream returns the "model" field of the request body the upstream received.
func modelSentToUpstream(t *testing.T, reqBody string) string {
	t.Helper()
	var got string
	withUpstreamCapture(t, "application/json", nonStreamJSONBody, func(r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]interface{}
		if json.Unmarshal(b, &m) == nil {
			got, _ = m["model"].(string)
		}
	})
	callHandleMessages(t, reqBody)
	return got
}

const nonStreamJSONBody = `{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","model":"DeepSeek-V4-Flash-0731","id":"test-1","usage":{"input_tokens":5,"output_tokens":5}}`

func withUpstream(t *testing.T, contentType, body string) *httptest.Server {
	return withUpstreamCapture(t, contentType, body, nil)
}

func callHandleMessages(t *testing.T, reqBody string) string {
	t.Helper()
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleMessages(w, req)
	return w.Body.String()
}

// Regression: an image-carrying request must reach the model its alias resolves
// to with the image block intact. The proxy must NOT swap in a separate "VLM"
// model to describe the image — that silently answered a DeepSeek-Flash turn
// with a different model (e.g. MiniMax-M3), overriding the model picked in the
// UI.
func TestImageForwardedToSelectedModelWithoutVLMSwap(t *testing.T) {
	setRoute(t, "sonnet", "DeepSeek-V4-Flash-0731", "")

	var mu sync.Mutex
	var gotModel string
	var gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]interface{}
		json.Unmarshal(b, &m)
		mu.Lock()
		gotModel, _ = m["model"].(string)
		gotBody = string(b)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, nonStreamJSONBody)
	}))
	t.Cleanup(upstream.Close)
	oldURL := cfg.Upstream.AnthropicURL
	cfg.Upstream.AnthropicURL = upstream.URL
	t.Cleanup(func() { cfg.Upstream.AnthropicURL = oldURL })

	callHandleMessages(t, `{"model":"sonnet","max_tokens":10,"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}},{"type":"text","text":"look"}]}]}`)

	mu.Lock()
	defer mu.Unlock()
	if gotModel != "DeepSeek-V4-Flash-0731" {
		t.Fatalf("image request must route to the selected model, upstream received %q", gotModel)
	}
	if !strings.Contains(gotBody, `"type":"image"`) {
		t.Fatalf("the image block must be forwarded intact, got: %s", gotBody)
	}
	if strings.Contains(gotBody, "这里有一个 image") {
		t.Fatalf("the image must not be replaced with a VLM description, got: %s", gotBody)
	}
}

// A request named "haiku" must be routed to the haiku target when configured.
func TestHaikuExplicitRouting(t *testing.T) {
	setRoute(t, "haiku", "GLM-5.2", "")

	got := modelSentToUpstream(t, `{"model":"haiku","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`)

	if got != "GLM-5.2" {
		t.Fatalf("haiku request should route to configured haiku target, upstream received %q", got)
	}
}

// When the config declares no haiku, loadConfig must fall back to the sonnet target.
// The test writes its own config file (the host's /etc/llm-proxy/config.toml may
// declare a haiku route, which would make the assertion meaningless).
func TestHaikuFallsBackToSonnetWhenUnconfigured(t *testing.T) {
	oldCfg := cfg
	oldRoutes := routeTargets
	t.Cleanup(func() {
		cfg = oldCfg
		routeTargets = oldRoutes
	})

	path := filepath.Join(t.TempDir(), "config.toml")
	content := `[routing]
sonnet = "DeepSeek-V4-Flash-0731"
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	t.Setenv("LLM_PROXY_CONFIG", path)

	if err := loadConfig(); err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	haiku := routeTargets["haiku"]
	if haiku.Model == "" {
		t.Fatal("haiku must fall back to a non-empty target")
	}
	if haiku != routeTargets["sonnet"] {
		t.Fatalf("unconfigured haiku must fall back to sonnet target, got %+v", haiku)
	}
}

// Regression: a non-streaming JSON reply must pass through untouched. Before the
// fix, the safety-net appended SSE framing, corrupting the JSON into "JSON + SSE tail".
func TestNonStreamJSONResponseUnmodified(t *testing.T) {
	withUpstream(t, "application/json", nonStreamJSONBody)

	resp := callHandleMessages(t, `{"model":"sonnet","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`)

	if !json.Valid([]byte(resp)) {
		t.Fatalf("non-streaming response must remain valid JSON, got: %q", resp)
	}
	if strings.Contains(resp, "event: message_stop") {
		t.Fatalf("non-streaming response must not get SSE footer appended, got: %q", resp)
	}
	if resp != nonStreamJSONBody {
		t.Fatalf("non-streaming response must be passed through byte-identical, got: %q", resp)
	}
}

// An SSE stream that is missing message_stop still gets the safety footer.
func TestSSEMissingStopGetsFooter(t *testing.T) {
	withUpstream(t, "text/event-stream", "event: message_start\ndata: {\"type\":\"message_start\"}\n\n")

	resp := callHandleMessages(t, `{"model":"sonnet","max_tokens":10,"stream":true,"messages":[{"role":"user","content":"hi"}]}`)

	if !strings.Contains(resp, "event: message_stop") {
		t.Fatalf("SSE stream missing stop frame should get footer appended, got: %q", resp)
	}
}

// An SSE stream that already ends with message_stop must not be duplicated.
func TestSSEWithStopNotDuplicated(t *testing.T) {
	withUpstream(t, "text/event-stream", "event: message_start\ndata: {\"type\":\"message_start\"}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")

	resp := callHandleMessages(t, `{"model":"sonnet","max_tokens":10,"stream":true,"messages":[{"role":"user","content":"hi"}]}`)

	if n := strings.Count(resp, "event: message_stop"); n != 1 {
		t.Fatalf("SSE stream with stop frame must not be duplicated, got %d occurrences: %q", n, resp)
	}
}

// LLM_PROXY_CONFIG env var overrides the hardcoded config path.
func TestConfigPathFromEnv(t *testing.T) {
	t.Setenv("LLM_PROXY_CONFIG", "/tmp/llm-proxy-test-"+t.Name()+".toml")
	if configPathFromEnv() != "/tmp/llm-proxy-test-"+t.Name()+".toml" {
		t.Fatal("LLM_PROXY_CONFIG should override the default config path")
	}
}

// SOPHNET_API_KEY env var overrides the key from the config file.
func TestAPIKeyFromEnvOverridesConfig(t *testing.T) {
	t.Setenv("SOPHNET_API_KEY", "env-key-123")
	t.Setenv("LLM_PROXY_CONFIG", "/nonexistent-"+t.Name()+".toml")
	cfg.Keys.Sophnet = "file-key"
	t.Cleanup(func() { cfg.Keys.Sophnet = "" })

	got := apiKey()
	if got != "env-key-123" {
		t.Fatalf("SOPHNET_API_KEY should override config key, got %q", got)
	}
}

// Without the env var, the key comes from the config file.
func TestAPIKeyFallsBackToConfig(t *testing.T) {
	t.Setenv("SOPHNET_API_KEY", "")
	cfg.Keys.Sophnet = "file-key"
	t.Cleanup(func() { cfg.Keys.Sophnet = "" })

	if got := apiKey(); got != "file-key" {
		t.Fatalf("config key should be used when env var is empty, got %q", got)
	}
}

// The first attempt forwards thinking verbatim (param + blocks untouched): the
// proxy must not degrade the request while the upstream accepts it, per the
// DeepSeek docs the history thinking is part of the context when tool calls exist.
func TestThinkingPassesThroughFirstAttempt(t *testing.T) {
	body := `{"model":"sonnet","thinking":{"type":"adaptive","budget_tokens":1024},"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]},{"role":"assistant","content":[{"type":"thinking","thinking":"secret chain","signature":"sig"},{"type":"text","text":"done"}]}]}`
	req, err := http.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var got map[string]interface{}
		if json.Unmarshal(b, &got) != nil {
			w.WriteHeader(500)
			return
		}
		// The upstream must see thinking enabled and the thinking block intact.
		th, _ := got["thinking"].(map[string]interface{})
		if th["type"] != "adaptive" {
			w.WriteHeader(500)
			io.WriteString(w, `{"type":"message","content":[{"type":"text","text":"thinking param changed"}]}`)
			return
		}
		msgs := got["messages"].([]interface{})
		asm := msgs[1].(map[string]interface{})
		content := asm["content"].([]interface{})
		if len(content) != 2 {
			w.WriteHeader(500)
			io.WriteString(w, `{"type":"message","content":[{"type":"text","text":"unexpected block count"}]}`)
			return
		}
		cb := content[0].(map[string]interface{})
		if cb["type"] != "thinking" || cb["thinking"] != "secret chain" {
			w.WriteHeader(500)
			io.WriteString(w, `{"type":"message","content":[{"type":"text","text":"thinking block altered"}]}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer upstream.Close()
	old := cfg.Upstream.AnthropicURL
	cfg.Upstream.AnthropicURL = upstream.URL
	defer func() { cfg.Upstream.AnthropicURL = old }()

	handleMessages(w, req)
	res := w.Result()
	respBody, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 {
		t.Fatalf("expected 200, got %d: %s", res.StatusCode, respBody)
	}
	if strings.Contains(string(respBody), "thinking param changed") ||
		strings.Contains(string(respBody), "altered") ||
		strings.Contains(string(respBody), "unexpected block count") {
		t.Fatalf("first attempt must pass thinking through untouched, got: %s", respBody)
	}
}

// The upstream runs thinking mode at the model level (independent of the client's
// `thinking` param) and rejects the request when ANY assistant message carries
// tool_use without a thinking block — verified against the live gateway, where a
// patched final turn still 400s if an earlier tool_use turn was left bare.
// Claude Code gets no thinking block for many tool turns, so it has none to pass
// back; the proxy supplies the empty placeholder the upstream accepts rather than
// forward a guaranteed 400.
func TestEnsureThinkingPassBack(t *testing.T) {
	cases := []struct {
		name string
		req  string
		want bool
	}{
		{
			"last assistant tool_use without thinking is patched",
			`{"model":"sonnet","messages":[{"role":"user","content":"time?"},{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"get_time","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"12:00"}]}]}`,
			true,
		},
		{
			"tool_use as the final message is patched",
			`{"model":"sonnet","messages":[{"role":"user","content":"time?"},{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"get_time","input":{}}]}]}`,
			true,
		},
		{
			"mid-history tool_use without thinking is patched too",
			`{"model":"sonnet","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"get_time","input":{}}]},{"role":"user","content":"go on"},{"role":"assistant","content":[{"type":"text","text":"done"}]}]}`,
			true,
		},
		{
			"every bare tool_use turn is patched, not just the last",
			`{"model":"sonnet","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"get_time","input":{}}]},{"role":"user","content":"ok"},{"role":"assistant","content":[{"type":"thinking","thinking":"","signature":""},{"type":"tool_use","id":"call_2","name":"get_date","input":{}}]},{"role":"user","content":"done"}]}`,
			true,
		},
		{
			"existing thinking block is left untouched",
			`{"model":"sonnet","messages":[{"role":"user","content":"time?"},{"role":"assistant","content":[{"type":"thinking","thinking":"think","signature":"sig"},{"type":"tool_use","id":"call_1","name":"get_time","input":{}}]}]}`,
			false,
		},
		{
			"text-only last assistant is left untouched",
			`{"model":"sonnet","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}`,
			false,
		},
		{
			"string content is left untouched",
			`{"model":"sonnet","messages":[{"role":"assistant","content":"done"}]}`,
			false,
		},
		{
			"no assistant message is left untouched",
			`{"model":"sonnet","messages":[{"role":"user","content":"hi"}]}`,
			false,
		},
	}
	for _, c := range cases {
		var req map[string]interface{}
		if err := json.Unmarshal([]byte(c.req), &req); err != nil {
			t.Fatalf("%s: bad json: %v", c.name, err)
		}
		// Indices of assistant messages that were bare (tool_use, no thinking)
		// before the call: exactly these must come back with the placeholder.
		var bare []int
		for i, raw := range req["messages"].([]interface{}) {
			msg, ok := raw.(map[string]interface{})
			if !ok || msg["role"] != "assistant" {
				continue
			}
			content, ok := msg["content"].([]interface{})
			if ok && hasContentBlockOfType(content, "tool_use") && !hasContentBlockOfType(content, "thinking") {
				bare = append(bare, i)
			}
		}

		if got := ensureThinkingPassBack(req); got != c.want {
			t.Errorf("%s: ensureThinkingPassBack = %v, want %v", c.name, got, c.want)
			continue
		}

		// Whatever the verdict, the invariant that leaves the upstream satisfied is
		// the same: no assistant message may carry tool_use without a thinking block.
		msgs := req["messages"].([]interface{})
		for i, raw := range msgs {
			msg, ok := raw.(map[string]interface{})
			if !ok || msg["role"] != "assistant" {
				continue
			}
			content, ok := msg["content"].([]interface{})
			if !ok || !hasContentBlockOfType(content, "tool_use") {
				continue
			}
			if !hasContentBlockOfType(content, "thinking") {
				t.Errorf("%s: message %d still carries tool_use without a thinking block", c.name, i)
			}
		}
		for _, i := range bare {
			content := msgs[i].(map[string]interface{})["content"].([]interface{})
			first := content[0].(map[string]interface{})
			if first["type"] != "thinking" || first["thinking"] != "" || first["signature"] != "" {
				t.Errorf("%s: message %d injected block = %v, want empty thinking block", c.name, i, first)
			}
		}
	}
}

// A tool_use turn replayed without a thinking block must reach the upstream
// already patched, so the pass-back 400 never happens in the first place.
func TestThinkingPassBackPatchedBeforeForward(t *testing.T) {
	body := `{"model":"sonnet","max_tokens":10,"thinking":{"type":"enabled","budget_tokens":1024},"tools":[{"name":"get_time","description":"Get time","input_schema":{"type":"object","properties":{"city":{"type":"string"}}}}],"messages":[{"role":"user","content":"date in Beijing?"},{"role":"assistant","content":[{"type":"tool_use","id":"call_0","name":"get_date","input":{"city":"Beijing"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_0","content":"2026-09-15"}]},{"role":"user","content":"time in Beijing?"},{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"get_time","input":{"city":"Beijing"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"12:00"}]}]}`

	calls := 0
	var mu sync.Mutex
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]interface{}
		if json.Unmarshal(b, &m) != nil {
			w.WriteHeader(500)
			return
		}
		mu.Lock()
		calls++
		mu.Unlock()
		// Mirror the real upstream contract: the client's `thinking` param is
		// irrelevant, and EVERY assistant message carrying tool_use must also
		// carry a thinking block — not just the last one.
		msgs := m["messages"].([]interface{})
		assistants := 0
		for _, raw := range msgs {
			msg, ok := raw.(map[string]interface{})
			if !ok || msg["role"] != "assistant" {
				continue
			}
			assistants++
			content, _ := msg["content"].([]interface{})
			var hasThinking, hasToolUse bool
			for _, rawBlock := range content {
				switch rawBlock.(map[string]interface{})["type"] {
				case "thinking":
					hasThinking = true
				case "tool_use":
					hasToolUse = true
				}
			}
			if hasToolUse && !hasThinking {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(400)
				io.WriteString(w, `{"error":{"message":"The `+"`content[].thinking`"+` in the thinking mode must be passed back to the API.","type":"invalid_request_error"}}`)
				return
			}
		}
		if assistants == 0 {
			w.WriteHeader(500)
			io.WriteString(w, "no assistant message reached the upstream")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	t.Cleanup(upstream.Close)
	oldURL := cfg.Upstream.AnthropicURL
	cfg.Upstream.AnthropicURL = upstream.URL
	t.Cleanup(func() { cfg.Upstream.AnthropicURL = oldURL })

	resp := callHandleMessages(t, body)
	if !strings.Contains(resp, "message_stop") {
		t.Fatalf("expected the patched request to succeed, got: %s", resp)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("expected a single upstream call (no retry needed), got %d", calls)
	}
}

// A request without thinking blocks must leave the body byte-for-byte identical
// (no re-serialization) so the latency/risk of touching untouched requests is 0.
func TestNoThinkingBlocksBodyUnchanged(t *testing.T) {
	body := `{"model":"sonnet","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`
	var capture []byte
	withUpstreamCapture(t, "text/event-stream", "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", func(r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		capture = b
	})
	callHandleMessages(t, body)
	if string(capture) != body {
		t.Fatalf("no-thinking request must pass through untouched, got: %s", capture)
	}
}

// A pass-back 400 the patch cannot cure (nothing to patch, upstream still
// rejecting) must reach the client unchanged, with no retry loop.
func TestThinking400WithoutCurePassesThrough(t *testing.T) {
	body := `{"model":"sonnet","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		io.WriteString(w, `{"error":{"message":"The `+"`content[].thinking`"+` in the thinking mode must be passed back to the API.","reqid":"test-2","type":"invalid_request_error"},"type":"error"}`)
	}))
	t.Cleanup(upstream.Close)
	oldURL := cfg.Upstream.AnthropicURL
	cfg.Upstream.AnthropicURL = upstream.URL
	t.Cleanup(func() { cfg.Upstream.AnthropicURL = oldURL })

	resp := callHandleMessages(t, body)
	if !strings.Contains(resp, "must be passed back") {
		t.Fatalf("400 must pass through when there is nothing to patch, got: %s", resp)
	}
	if calls != 1 {
		t.Fatalf("must not retry when there is nothing to patch, upstream called %d times", calls)
	}
}

// A thinking block whose `thinking` field is missing must be pinned to an empty
// string so Claude Code does not crash on `.thinking.length`.
func TestNormalizeThinkingBlockMissingThinkingField(t *testing.T) {
	raw := json.RawMessage(`{"type":"thinking","signature":"sig123"}`)
	out, ok := normalizeThinkingBlock(raw)
	if !ok {
		t.Fatal("normalize should rewrite a thinking block missing the thinking field")
	}
	var block map[string]interface{}
	json.Unmarshal(out, &block)
	if block["thinking"] != "" {
		t.Fatalf("thinking field should be empty string, got %#v", block["thinking"])
	}
	// The block's signature cannot be kept: DeepSeek puts a fake (non-Anthropic) signature
	// here, and Claude Code cryptographically verifies it. An empty `thinking` next to an
	// unverifiable signature fails validation ("Invalid signature in thinking block"), so
	// the signature must be cleared together with `thinking` — yielding the canonical
	// thinking-block-start shape that Claude Code accepts without any validation error.
	if block["signature"] != "" {
		t.Fatalf("signature must be cleared to empty string so Claude Code skips validation, got %#v", block["signature"])
	}
}

// A valid thinking block with a string thinking field must pass through unchanged —
// including its signature, since Claude Code only validates the malformed shape.
func TestNormalizeThinkingBlockValidPassesThrough(t *testing.T) {
	raw := json.RawMessage(`{"type":"thinking","thinking":"hello","signature":"sig123"}`)
	if _, ok := normalizeThinkingBlock(raw); ok {
		t.Fatal("normalize should not rewrite a valid thinking block")
	}
}

// A non-thinking block must never be rewritten.
func TestNormalizeThinkingBlockNonThinking(t *testing.T) {
	raw := json.RawMessage(`{"type":"text","text":"hi"}`)
	if _, ok := normalizeThinkingBlock(raw); ok {
		t.Fatal("normalize should not rewrite a text block")
	}
}

// The SSE normalizing reader must rewrite a broken thinking content_block_start and
// leave the rest of the stream intact. The normalized event must preserve its full
// envelope (`type`, `index` and the nested content_block), or Claude Code fails to
// recognize the start of a thinking block and renders its `thinking_delta` as body text.
func TestThinkingNormalizingReaderRewritesBrokenThinkingStart(t *testing.T) {
	stream := "event: message_start\ndata: {\"type\":\"message_start\"}\n\n" +
		"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"signature\":\"sig123\"}}\n\n" +
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	out, err := io.ReadAll(newThinkingNormalizingReader(strings.NewReader(stream)))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	raw := string(out)
	if !strings.Contains(raw, `"thinking":""`) {
		t.Fatalf("thinking field should be normalized to empty string, got: %s", raw)
	}
	if strings.Contains(string(raw), `"signature":"sig123"`) {
		t.Fatalf("the malformed block's fake signature must be cleared (Claude Code verifies signatures and errors on a mismatch), got: %s", raw)
	}
	if !strings.Contains(string(raw), "event: message_stop") {
		t.Fatalf("stream tail must be preserved, got: %s", raw)
	}
	// The rewritten content_block_start must keep its event payload envelope — a
	// `type` of `content_block_start` and its `index` — or Claude Code drops the
	// block as unparseable and leaks the thinking deltas into the body text.
	var ev struct {
		Type         string `json:"type"`
		Index        int    `json:"index"`
		ContentBlock struct {
			Type      string `json:"type"`
			Thinking  string `json:"thinking"`
			Signature string `json:"signature"`
		} `json:"content_block"`
	}
	if err := json.Unmarshal([]byte(ssePayload(raw, "content_block_start")), &ev); err != nil {
		t.Fatalf("content_block_start event should remain valid JSON, got: %s", raw)
	}
	if ev.Type != "content_block_start" {
		t.Fatalf("event payload type must stay content_block_start, got %q", ev.Type)
	}
	if ev.Index != 0 {
		t.Fatalf("event payload index must be preserved, got %d", ev.Index)
	}
	if ev.ContentBlock.Type != "thinking" {
		t.Fatalf("content_block.type must stay thinking, got %q", ev.ContentBlock.Type)
	}
	if ev.ContentBlock.Thinking != "" {
		t.Fatalf("content_block.thinking must be normalized to empty string, got %q", ev.ContentBlock.Thinking)
	}
	if ev.ContentBlock.Signature != "" {
		t.Fatalf("content_block.signature must be cleared, got %q", ev.ContentBlock.Signature)
	}
}

// ssePayload extracts the data: JSON of the first event whose `event:` label matches.
func ssePayload(stream, wantEvent string) string {
	var curEvent, curData string
	for _, line := range strings.Split(stream, "\n") {
		if line == "" {
			if curEvent == wantEvent {
				return curData
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
		return curData
	}
	return ""
}
