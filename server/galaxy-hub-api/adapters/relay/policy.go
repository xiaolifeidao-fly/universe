package relay

import (
	"encoding/json"
	"strings"

	"contract"
)

// 分组策略落到请求体上（2026-09-22）。
//
// 推理强度与「快速」这两个旋钮原先由客户端在请求体里自己拨，而它们直接换算成钱：
// 深档烧掉的推理 token 比浅档多一个量级，快速档上游自己就按更贵的价收。
// 现在它们是**分组的属性** —— 密钥选中哪个分组，就按那个分组卖的档次跑。
//
// 只记账、不改请求体是不行的：上游照着请求体里那一档跑，平台按夹过之后的那一档收，
// 差额全由平台垫，而且两边都不会报错。所以这里要真的把字节改掉。

// 「快速」在两族请求体里的表示。
//
// 两族用的是**同一个字段名** service_tier，取值不同：
//
//	anthropic  auto（默认，可能被调度到快速通道）/ standard_only（明确不要）/ priority（要）
//	openai     auto / default / flex / priority
//
// 判定只认 priority：auto 是「你看着办」，不是使用者要的快速档，把它当快速会让
// 每一个没写这个字段的请求都被分组闸拦一道 —— 而那是绝大多数请求。
//
// 关掉的写法两族各写各的：anthropic 写 standard_only（它有一个明确的「不要快速」值），
// openai 写 default。**是改写不是删除** —— 删掉字段等于回到 auto，上游仍然可能把它
// 调度到快速通道上，而平台这边已经按普通档记了账。
const (
	fastField              = "service_tier"
	fastValue              = "priority"
	standardValueAnthropic = "standard_only"
	standardValueOpenAI    = "default"
)

// parseFast 请求体里要的是不是快速。
func parseFast(tier string) bool {
	return strings.EqualFold(strings.TrimSpace(tier), fastValue)
}

// standardTier 这一族「明确不要快速」怎么写。
func standardTier(family string) string {
	if family == FamilyOpenAI {
		return standardValueOpenAI
	}
	return standardValueAnthropic
}

// applyPolicy 按分组把请求体改到位，返回改写后的强度与快速标记。
//
// 顺序是先算后改：contract.GroupPolicy.Apply 是唯一的判定出处（服务端记账、
// 这里改写请求体，两处必须同源），这里只负责把结论写进字节里。
//
// 改不动的情况（请求体不是一个 JSON 对象、字段结构诡异）一律**保持原样并如实返回**
// 原来的值：宁可这一次按客户端要的档跑、按客户端要的档记账，也不要出现
// 「请求体是深档、账单是浅档」这种两边不一致 —— 后者是平台在亏钱，且查不出来。
func (a *Adapter) applyPolicy(in *input, policy contract.GroupPolicy) {
	effort, fast, changed := policy.Apply(in.effort, in.fast)
	if !changed {
		in.effort, in.fast = effort, fast
		return
	}
	patched := in.body
	ok := true
	if effort != in.effort {
		patched, ok = writeEffort(patched, in.spec.family, in.effortFromBudget, effort)
	}
	if ok && fast != in.fast {
		patched, ok = writeFast(patched, in.spec.family)
	}
	if !ok {
		// 改不动就当这一道闸没生效：计价跟着请求体走，而不是反过来。
		return
	}
	in.body, in.effort, in.fast = patched, effort, fast
}

// writeEffort 把强度写进请求体。
//
//	anthropic  output_config.effort —— 当前模型上的正主。
//	           老模型（Haiku 4.5 及更早）没有它，深浅刻度是 thinking.budget_tokens；
//	           这次的强度本来就是从预算折出来的（fromBudget 为真），那就改回预算，
//	           而不是给一个不认识 output_config 的上游塞一个它会忽略的字段。
//	openai     reasoning.effort。
func writeEffort(raw []byte, family string, fromBudget bool, effort contract.Effort) ([]byte, bool) {
	switch family {
	case FamilyOpenAI:
		return setNested(raw, "reasoning", "effort", effort)
	case FamilyAnthropic:
		if fromBudget {
			return setNested(raw, "thinking", "budget_tokens", effortBudget(effort))
		}
		return setNested(raw, "output_config", "effort", effort)
	}
	return raw, false
}

// writeFast 把这一次钉成普通档。
func writeFast(raw []byte, family string) ([]byte, bool) {
	return setTop(raw, fastField, standardTier(family))
}

// effortBudget 档位 → 老式 thinking 预算。
//
// 取的是 Claude Code 那三档预设（think = 4000、think hard = 10000、ultrathink = 31999），
// 也就是 budgetEffort 的逆：一条 think hard 的请求被夹到 low 之后，上游收到的
// 是一个它真的见过的预算值，而不是一个我们算出来的中间数。
// 老口径没有 xhigh / max，它们和 high 落在同一个预算上。
func effortBudget(effort contract.Effort) int64 {
	switch effort {
	case contract.EffortNone, contract.EffortMinimal, contract.EffortLow:
		return 4000
	case contract.EffortMedium:
		return 10000
	default:
		return 31999
	}
}

// setTop / setNested 只改目标字段，其余字节原样保留（同 injectIncludeUsage 的做法）。
//
// 不整体反序列化再序列化：请求体里有我们不认识的字段（上游随时在加），
// 一次往返就可能把它们的顺序、数字精度改掉，而那是原样转发的承诺。
func setTop(raw []byte, field string, value any) ([]byte, bool) {
	payload, ok := decodeObject(raw)
	if !ok {
		return raw, false
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return raw, false
	}
	payload[field] = encoded
	return encodeObject(payload, raw)
}

func setNested(raw []byte, object, field string, value any) ([]byte, bool) {
	payload, ok := decodeObject(raw)
	if !ok {
		return raw, false
	}
	inner := map[string]any{}
	if existing, found := payload[object]; found {
		if err := json.Unmarshal(existing, &inner); err != nil || inner == nil {
			inner = map[string]any{}
		}
	}
	inner[field] = value
	encoded, err := json.Marshal(inner)
	if err != nil {
		return raw, false
	}
	payload[object] = encoded
	return encodeObject(payload, raw)
}

func decodeObject(raw []byte) (map[string]json.RawMessage, bool) {
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(raw, &payload); err != nil || payload == nil {
		return nil, false
	}
	return payload, true
}

func encodeObject(payload map[string]json.RawMessage, fallback []byte) ([]byte, bool) {
	out, err := json.Marshal(payload)
	if err != nil {
		return fallback, false
	}
	return out, true
}
