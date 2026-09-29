package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// 网关翻译层仍在响应里交错回旧 exclusive 语义（生产 09-28 仍有 8.4% 的 cr>input 行）：
// 带 billing_usage 标记、但数字本身是 exclusive（input < cached）时必须原样透传，
// 否则二次扣除会把 input 拉成 0 甚至负数。
func TestInclusiveMarkerButExclusiveNumbers(t *testing.T) {
	raw := `{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"billing_usage":{"semantic":"openai"},"claude_cache_creation_5_m_tokens":0,"input_tokens":139,"cache_read_input_tokens":11136,"cache_creation_input_tokens":0,"output_tokens":4124}}`
	in := buildSSE([][2]string{{"message_delta", raw}})
	events := collectEvents(t, newResponseRewriter(bytes.NewReader(in), nil))
	var u map[string]interface{}
	if err := json.Unmarshal([]byte(events[0][1]), &u); err != nil {
		t.Fatal(err)
	}
	usage := u["usage"].(map[string]interface{})
	if int(usage["input_tokens"].(float64)) != 139 {
		t.Fatalf("exclusive-shaped usage with markers must pass through, got %v", usage["input_tokens"])
	}
	if !strings.Contains(events[0][1], "billing_usage") {
		t.Fatal("marker fields must be preserved")
	}
}
