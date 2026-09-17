package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// stallGate holds a handler open until it is released, letting tests simulate an
// upstream that accepted a request and then never answers. The release must be
// closed before the httptest server is closed, or the handler goroutine would
// keep the server's Close() from returning.
type stallGate struct {
	once sync.Once
	ch   chan struct{}
}

func newStallGate() *stallGate {
	return &stallGate{ch: make(chan struct{})}
}

func (g *stallGate) hold() { <-g.ch }

func (g *stallGate) release() { g.once.Do(func() { close(g.ch) }) }

// withStallRelease registers the gate's release so it runs before the upstream
// server closes (cleanups run LIFO).
func withStallRelease(t *testing.T, g *stallGate) {
	t.Helper()
	t.Cleanup(g.release)
}

// withShortTimeouts sets small timeout/retry config for tests and restores the
// previous values on cleanup.
func setShortTimeouts(t *testing.T, headerSec, bodyIdleSec, maxRetries int) {
	t.Helper()
	oldH, oldB, oldR := cfg.Upstream.HeaderTimeoutSeconds, cfg.Upstream.BodyIdleSeconds, cfg.Upstream.MaxRetries
	cfg.Upstream.HeaderTimeoutSeconds = headerSec
	cfg.Upstream.BodyIdleSeconds = bodyIdleSec
	cfg.Upstream.MaxRetries = maxRetries
	t.Cleanup(func() {
		cfg.Upstream.HeaderTimeoutSeconds, cfg.Upstream.BodyIdleSeconds, cfg.Upstream.MaxRetries = oldH, oldB, oldR
	})
}

// openaiSSEChunk is a minimal OpenAI streaming chunk.
const openaiSSEChunk = `data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}`

// An upstream that stalls past the header timeout must be retried: the retry
// succeeds and the client never sees a failure.
func TestOpenAIHeaderTimeoutRetriesAndSucceeds(t *testing.T) {
	setRoute(t, "flash", "glm-5.3-flash", "openai")
	setShortTimeouts(t, 1, 0, 2)
	gate := newStallGate()

	var mu sync.Mutex
	calls := 0
	withOpenAIUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		n := calls
		mu.Unlock()
		if n == 1 {
			// Hold the connection open past the 1s header timeout.
			gate.hold()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"chatcmpl-1","model":"glm-5.3-flash","choices":[{"index":0,"message":{"role":"assistant","content":"retried ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)
	})
	// Release registered AFTER the server so its cleanup runs before Close.
	withStallRelease(t, gate)

	resp := callHandleMessages(t, `{"model":"flash","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`)

	mu.Lock()
	gotCalls := calls
	mu.Unlock()
	if gotCalls != 2 {
		t.Fatalf("header timeout must trigger one retry, upstream called %d times", gotCalls)
	}
	if !strings.Contains(resp, "retried ok") {
		t.Fatalf("client must receive the successful retry reply, got: %s", resp)
	}
}

// When every attempt times out, the client must receive a 502 carrying an
// Anthropic error JSON body — never a hang and never a plain-text body.
func TestOpenAIHeaderTimeoutExhaustedReturnsJSONError(t *testing.T) {
	setRoute(t, "flash", "glm-5.3-flash", "openai")
	setShortTimeouts(t, 1, 0, 1)
	gate := newStallGate()

	withOpenAIUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		gate.hold()
	})
	withStallRelease(t, gate)

	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{"model":"flash","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`))
	w := httptest.NewRecorder()
	handleMessages(w, req)
	res := w.Result()
	body, _ := io.ReadAll(res.Body)

	if res.StatusCode != 502 {
		t.Fatalf("exhausted retries must yield 502, got %d", res.StatusCode)
	}
	var e map[string]interface{}
	if err := json.Unmarshal(body, &e); err != nil {
		t.Fatalf("error body must be valid JSON, got %q", body)
	}
	if e["type"] != "error" {
		t.Fatalf("error body must be the Anthropic error envelope, got %q", body)
	}
}

// A streaming upstream that goes silent mid-stream must terminate the client
// stream with an Anthropic error event instead of hanging.
func TestOpenAIStreamBodyStallEmitsSSEError(t *testing.T) {
	setRoute(t, "flash", "glm-5.3-flash", "openai")
	setShortTimeouts(t, 0, 1, 0)
	gate := newStallGate()

	withOpenAIUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		f, _ := w.(http.Flusher)
		fmt.Fprint(w, openaiSSEChunk+"\n\n")
		f.Flush()
		gate.hold()
	})
	withStallRelease(t, gate)

	start := time.Now()
	resp := callHandleMessages(t, `{"model":"flash","max_tokens":10,"stream":true,"messages":[{"role":"user","content":"hi"}]}`)

	if strings.Contains(resp, "message_stop") {
		t.Fatalf("a stalled stream must not be reported as a clean stop, got: %s", resp)
	}
	if p := ssePayload(resp, "error"); p == "" {
		t.Fatalf("stalled stream must emit an error event, got: %s", resp)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("stalled stream must terminate near the idle timeout, took %s", d)
	}
}

// The Anthropic-gateway streaming path gets the same stall protection: silence
// from the upstream ends the stream with an error event.
func TestAnthropicStreamBodyStallEmitsSSEError(t *testing.T) {
	setRoute(t, "sonnet", "DeepSeek-V4-Flash-0731", "")
	setShortTimeouts(t, 0, 1, 0)
	gate := newStallGate()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		f, _ := w.(http.Flusher)
		fmt.Fprint(w, "event: message_start\ndata: {\"type\":\"message_start\"}\n\n")
		f.Flush()
		gate.hold()
	}))
	t.Cleanup(upstream.Close)
	oldURL := cfg.Upstream.AnthropicURL
	cfg.Upstream.AnthropicURL = upstream.URL
	t.Cleanup(func() { cfg.Upstream.AnthropicURL = oldURL })
	withStallRelease(t, gate)

	resp := callHandleMessages(t, `{"model":"sonnet","max_tokens":10,"stream":true,"messages":[{"role":"user","content":"hi"}]}`)

	if p := ssePayload(resp, "error"); p == "" {
		t.Fatalf("stalled anthropic stream must emit an error event, got: %s", resp)
	}
}

// /v1/chat/completions passthrough retries a transient upstream 503 and returns
// the successful reply.
func TestChatCompletionsRetriesOn503(t *testing.T) {
	setShortTimeouts(t, 0, 0, 2)

	var mu sync.Mutex
	calls := 0
	withOpenAIUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		n := calls
		mu.Unlock()
		if n == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(503)
			io.WriteString(w, `{"code":503,"msg":"Connection error, please retry"}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
	})

	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"x","messages":[{"role":"user","content":"hi"}]}`))
	w := httptest.NewRecorder()
	handleChatCompletions(w, req)
	res := w.Result()
	body, _ := io.ReadAll(res.Body)

	mu.Lock()
	gotCalls := calls
	mu.Unlock()
	if gotCalls != 2 {
		t.Fatalf("503 must be retried, upstream called %d times", gotCalls)
	}
	if res.StatusCode != 200 || string(body) != `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}` {
		t.Fatalf("client must get the successful passthrough, status=%d body=%s", res.StatusCode, body)
	}
}

// loadConfig fills sensible timeout defaults when the file omits them.
func TestTimeoutConfigDefaults(t *testing.T) {
	oldCfg := cfg
	oldRoutes := routeTargets
	t.Cleanup(func() { cfg = oldCfg; routeTargets = oldRoutes })

	path := filepath.Join(t.TempDir(), "config.toml")
	content := `[proxy]
port = 8088

[routing]
sonnet = "DeepSeek-V4-Flash-0731"
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LLM_PROXY_CONFIG", path)
	if err := loadConfig(); err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.Upstream.HeaderTimeoutSeconds != 120 {
		t.Fatalf("header timeout default must be 120s, got %d", cfg.Upstream.HeaderTimeoutSeconds)
	}
	if cfg.Upstream.BodyIdleSeconds != 90 {
		t.Fatalf("body idle default must be 90s, got %d", cfg.Upstream.BodyIdleSeconds)
	}
	if cfg.Upstream.MaxRetries != 2 {
		t.Fatalf("max retries default must be 2, got %d", cfg.Upstream.MaxRetries)
	}
}

// isRetryableError must accept transient network failures and reject
// client-side cancelation and non-network errors.
func TestIsRetryableError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"timeout awaiting response headers", errors.New(`Post "https://x": net/http: timeout awaiting response headers`), true},
		{"connection reset", errors.New("Post \"https://x\": read tcp: connection reset by peer"), true},
		{"unexpected EOF", errors.New("Post \"https://x\": unexpected EOF"), true},
		{"connection refused", errors.New(`Post "https://x": dial tcp: connection refused`), true},
		{"client canceled", context.Canceled, false},
		// DeadlineExceeded satisfies net.Error.Timeout(); whether it comes from the
		// client is judged in postUpstream via ctx.Err(), so the classifier treats
		// any deadline as a retryable timeout.
		{"deadline exceeded", context.DeadlineExceeded, true},
		{"plain error", errors.New("boom"), false},
	}
	for _, c := range cases {
		if got := isRetryableError(c.err); got != c.want {
			t.Errorf("%s: isRetryableError = %v, want %v", c.name, got, c.want)
		}
	}
}

// isRetryableStatus accepts 429/5xx and rejects 4xx that mean a client-ish error.
func TestIsRetryableStatus(t *testing.T) {
	for _, code := range []int{429, 500, 502, 503, 504} {
		if !isRetryableStatus(code) {
			t.Errorf("status %d must be retryable", code)
		}
	}
	for _, code := range []int{400, 401, 403, 404, 422, 200} {
		if isRetryableStatus(code) {
			t.Errorf("status %d must not be retryable", code)
		}
	}
}