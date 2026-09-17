package main

import (
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync/atomic"
)

// leakRewriter 在 SSE 流层面兜底修复 DeepSeek V4 Pro 的"工具调用泄漏"问题。
//
// 背景：DeepSeek V4 Pro（含 0813）跑 agent 时，会间歇性"忘记" function
// calling 通道，把工具调用写成 XML 文本塞进 content，而不是走标准的 tool_use
// content block。上游（sophnet 的 anthropic 兼容层）把这段 XML 当普通 text 透传，
// 于是 Claude Code 直接把 <invoke>/<tool_call> 展示给用户，工具根本没执行。
//
// 修复策略：在 text content block 层做"原地改写"——
//   - 若一个 text block 的内容整体就是一段 <invoke name="X">...</invoke> 或
//     <tool_call>...</tool_call> XML，且 X 命中请求里声明的工具白名单，
//     则把该 text block 改写为等价的 tool_use block（复用同一个 index）。
//   - 否则原样透传，不改变任何正常行为。
//
// 判定只对"整个 text block 就是一段 XML"生效（正文+XML 混合的罕见场景不拦截），
// 因此无需做 index 重排，实现简单且不会打乱 Anthropic 流式协议顺序。

type leakedCall struct {
	name string
	args map[string]interface{}
}

var (
	reInvoke   = regexp.MustCompile(`(?s)<invoke\s+name="([^"]+)"[^>]*>(.*?)</invoke>`)
	reParam    = regexp.MustCompile(`(?s)<parameter\s+name="([^"]+)"[^>]*>(.*?)</parameter>`)
	reToolCall = regexp.MustCompile(`(?s)<tool_call\b[^>]*>(.*?)</tool_call>`)
	reNameAttr = regexp.MustCompile(`name="([^"]+)"`)
)

// probeWindow：探测窗口。text block 开头这段字符内出现 <invoke/<tool_call 前缀
// 才判定为泄漏；超过窗口仍未出现则判定为正常文本，转入直通流式。
const probeWindow = 64

const (
	stProbe       = iota // 探测：text block 开头被缓冲，尚未决定是 text 还是 tool_use
	stLeak               // 正在累积泄漏 XML
	stPassthrough        // 已判定为正常文本，直通流式
)

type leakRewriter struct {
	allowed  map[string]bool
	hasTools bool

	inText    bool
	textIndex int
	state     int
	buf       strings.Builder
	leakOpen  string // "<invoke" 或 "<tool_call"
}

// newLeakRewriter 从请求体里提取工具名白名单。请求未声明 tools 时 hasTools=false，
// 此时不拦截任何内容（agent 本就不期望工具调用，避免把正文里的 XML 举例误判）。
func newLeakRewriter(req map[string]interface{}) *leakRewriter {
	allowed := map[string]bool{}
	if tools, ok := req["tools"].([]interface{}); ok {
		for _, t := range tools {
			if m, ok := t.(map[string]interface{}); ok {
				if n, ok := m["name"].(string); ok && n != "" {
					allowed[n] = true
				}
			}
		}
	}
	return &leakRewriter{allowed: allowed, hasTools: len(allowed) > 0, state: stPassthrough}
}

// process 消费一个 SSE 事件（event + data），向 pw 输出 0..n 个事件。
func (lr *leakRewriter) process(pw io.Writer, event, data string) {
	switch event {
	case "content_block_start":
		lr.handleBlockStart(pw, data)
	case "content_block_delta":
		lr.handleDelta(pw, data)
	case "content_block_stop":
		lr.handleBlockStop(pw, data)
	default:
		if event == "message_stop" {
			lr.flush(pw)
		}
		writeSSE(pw, event, data)
	}
}

func (lr *leakRewriter) handleBlockStart(pw io.Writer, data string) {
	var ev struct {
		Index        int `json:"index"`
		ContentBlock struct {
			Type string `json:"type"`
		} `json:"content_block"`
	}
	if json.Unmarshal([]byte(data), &ev) == nil && ev.ContentBlock.Type == "text" {
		lr.inText = true
		lr.textIndex = ev.Index
		lr.state = stProbe
		lr.buf.Reset()
		return // 缓冲 text block 的 start，探测后决定如何发出
	}
	lr.inText = false
	writeSSE(pw, "content_block_start", data)
}

func (lr *leakRewriter) handleDelta(pw io.Writer, data string) {
	var ev struct {
		Index int `json:"index"`
		Delta struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
	}
	if json.Unmarshal([]byte(data), &ev) != nil || ev.Delta.Type != "text_delta" {
		writeSSE(pw, "content_block_delta", data)
		return
	}
	if !lr.inText || ev.Index != lr.textIndex {
		writeSSE(pw, "content_block_delta", data)
		return
	}
	switch lr.state {
	case stProbe:
		lr.buf.WriteString(ev.Delta.Text)
		lr.probe(pw)
	case stLeak:
		lr.buf.WriteString(ev.Delta.Text)
		lr.tryCloseLeak(pw)
	case stPassthrough:
		writeTextDelta(pw, lr.textIndex, ev.Delta.Text)
	}
}

func (lr *leakRewriter) handleBlockStop(pw io.Writer, data string) {
	var ev struct {
		Index int `json:"index"`
	}
	json.Unmarshal([]byte(data), &ev)
	if lr.inText && ev.Index == lr.textIndex && lr.state != stPassthrough {
		// text block 结束但仍处于探测/泄漏状态：缓冲内容不是完整泄漏，当正常文本补发。
		writeTextBlockStart(pw, lr.textIndex)
		if lr.buf.Len() > 0 {
			writeTextDelta(pw, lr.textIndex, lr.buf.String())
		}
	}
	lr.inText = false
	lr.state = stPassthrough
	lr.buf.Reset()
	writeSSE(pw, "content_block_stop", data)
}

// probe 在探测窗口内判断当前 text block 是否为泄漏。
func (lr *leakRewriter) probe(pw io.Writer) {
	s := lr.buf.String()
	if pos := indexOfOpenTag(s); pos >= 0 && pos < probeWindow {
		lr.state = stLeak
		lr.leakOpen = openTagKind(s[pos:])
		lr.buf.Reset()
		lr.buf.WriteString(s[pos:])
		lr.tryCloseLeak(pw)
		return
	}
	if len(s) > probeWindow {
		lr.state = stPassthrough
		writeTextBlockStart(pw, lr.textIndex)
		writeTextDelta(pw, lr.textIndex, s)
		lr.buf.Reset()
	}
}

// tryCloseLeak 检查泄漏缓冲是否已含完整闭合标签；闭合则尝试解析并转换。
func (lr *leakRewriter) tryCloseLeak(pw io.Writer) {
	s := lr.buf.String()
	closeTag := "</invoke>"
	if lr.leakOpen == "<tool_call" {
		closeTag = "</tool_call>"
	}
	idx := strings.Index(s, closeTag)
	if idx < 0 {
		return // 尚未闭合，继续累积
	}
	end := idx + len(closeTag)
	xmlStr := s[:end]
	rest := s[end:]

	call, ok := parseLeakedXML(xmlStr)
	// 仅当"整个 text block 就是这段 XML"（rest 为空）且命中工具白名单时才转换，
	// 避免混合场景下的 index 冲突与误判。
	if ok && lr.hasTools && lr.allowed[call.name] && rest == "" {
		lr.emitToolUse(pw, call)
		lr.state = stPassthrough
		lr.buf.Reset()
		return
	}

	// 不能转换（未命中白名单 / 解析失败 / 正文+XML 混合）→ 全部当正常文本直通。
	lr.state = stPassthrough
	lr.buf.Reset()
	writeTextBlockStart(pw, lr.textIndex)
	writeTextDelta(pw, lr.textIndex, xmlStr)
	if rest != "" {
		writeTextDelta(pw, lr.textIndex, rest)
	}
}

// flush 在 message_stop 前兜底：若仍处于探测/泄漏状态（半截 XML 被截断），
// 把缓冲内容当正常文本补发，避免丢内容或让客户端卡住。
func (lr *leakRewriter) flush(pw io.Writer) {
	if !lr.inText || lr.state == stPassthrough {
		return
	}
	writeTextBlockStart(pw, lr.textIndex)
	if lr.buf.Len() > 0 {
		writeTextDelta(pw, lr.textIndex, lr.buf.String())
	}
	lr.inText = false
	lr.state = stPassthrough
	lr.buf.Reset()
}

var toolIDSeq uint64

// emitToolUse 把一段泄漏的工具调用改写为标准 tool_use content block 事件序列，
// 复用原 text block 的 index，参数通过 input_json_delta 一次性给出。
func (lr *leakRewriter) emitToolUse(pw io.Writer, call *leakedCall) {
	id := fmt.Sprintf("toolu_leak_%d", atomic.AddUint64(&toolIDSeq, 1))
	argsJSON, _ := json.Marshal(call.args)

	writeJSONEvent(pw, "content_block_start", map[string]interface{}{
		"type":  "content_block_start",
		"index": lr.textIndex,
		"content_block": map[string]interface{}{
			"type":  "tool_use",
			"id":    id,
			"name":  call.name,
			"input": map[string]interface{}{},
		},
	})
	writeJSONEvent(pw, "content_block_delta", map[string]interface{}{
		"type":  "content_block_delta",
		"index": lr.textIndex,
		"delta": map[string]interface{}{
			"type":         "input_json_delta",
			"partial_json": string(argsJSON),
		},
	})
}

// --- 解析辅助 ---

// parseLeakedXML 从一段 XML 文本里解析出工具名与参数，支持两种常见泄漏形态：
//  1. Anthropic 风格：<invoke name="Bash"><parameter name="command">ls</parameter></invoke>
//  2. OpenAI 兼容层风格：<tool_call name="Bash">{"command":"ls"}</tool_call>
//     或 <tool_call>{"name":"Bash","arguments":{...}}</tool_call>
func parseLeakedXML(s string) (*leakedCall, bool) {
	if m := reInvoke.FindStringSubmatch(s); m != nil {
		args := map[string]interface{}{}
		for _, p := range reParam.FindAllStringSubmatch(m[2], -1) {
			args[p[1]] = parseJSONish(p[2])
		}
		return &leakedCall{name: m[1], args: args}, true
	}
	if m := reToolCall.FindStringSubmatch(s); m != nil {
		if nm := reNameAttr.FindStringSubmatch(m[0]); nm != nil {
			return &leakedCall{name: nm[1], args: parseArgsFromJSON(m[1])}, true
		}
		var obj map[string]interface{}
		if json.Unmarshal([]byte(strings.TrimSpace(m[1])), &obj) == nil {
			if name, _ := obj["name"].(string); name != "" {
				args, _ := obj["arguments"].(map[string]interface{})
				if args == nil {
					args = map[string]interface{}{}
				}
				return &leakedCall{name: name, args: args}, true
			}
		}
	}
	return nil, false
}

// parseJSONish 尝试把字符串解析成 JSON 值，失败则原样返回（trim 后）字符串。
func parseJSONish(s string) interface{} {
	t := strings.TrimSpace(s)
	var v interface{}
	if json.Unmarshal([]byte(t), &v) == nil {
		return v
	}
	return t
}

// parseArgsFromJSON 从 <tool_call> 的 JSON 体内提取 arguments。
func parseArgsFromJSON(inner string) map[string]interface{} {
	t := strings.TrimSpace(inner)
	var v interface{}
	if json.Unmarshal([]byte(t), &v) == nil {
		if m, ok := v.(map[string]interface{}); ok {
			if a, ok := m["arguments"].(map[string]interface{}); ok {
				return a
			}
			return m
		}
	}
	return map[string]interface{}{}
}

// indexOfOpenTag 返回 s 中最早出现的 <invoke 或 <tool_call 起始位置，无则 -1。
func indexOfOpenTag(s string) int {
	a := strings.Index(s, "<invoke")
	b := strings.Index(s, "<tool_call")
	if a < 0 {
		return b
	}
	if b < 0 {
		return a
	}
	if a < b {
		return a
	}
	return b
}

func openTagKind(s string) string {
	if strings.HasPrefix(s, "<invoke") {
		return "<invoke"
	}
	if strings.HasPrefix(s, "<tool_call") {
		return "<tool_call"
	}
	return ""
}

// --- SSE 输出辅助 ---

func writeSSE(pw io.Writer, event, data string) {
	fmt.Fprintf(pw, "event: %s\ndata: %s\n\n", event, data)
}

func writeJSONEvent(pw io.Writer, event string, v interface{}) {
	b, _ := json.Marshal(v)
	writeSSE(pw, event, string(b))
}

func writeTextBlockStart(pw io.Writer, index int) {
	writeJSONEvent(pw, "content_block_start", map[string]interface{}{
		"type":  "content_block_start",
		"index": index,
		"content_block": map[string]interface{}{
			"type": "text",
			"text": "",
		},
	})
}

func writeTextDelta(pw io.Writer, index int, text string) {
	writeJSONEvent(pw, "content_block_delta", map[string]interface{}{
		"type":  "content_block_delta",
		"index": index,
		"delta": map[string]interface{}{
			"type": "text_delta",
			"text": text,
		},
	})
}
