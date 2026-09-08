package galaxy

import "testing"

// 抽检比的是结构不是内容。这组用例把「什么算像、什么算不像」钉死：
// 同一个提问两次回答本来就不一样，但事件序列与字段形状是可比的。

func TestSignatureIgnoresContent(t *testing.T) {
	first := "event: message_start\ndata: {\"type\":\"message_start\"}\n\n" +
		"event: content_block_delta\ndata: {\"delta\":{\"text\":\"你好\"}}\n\n" +
		"event: message_delta\ndata: {\"usage\":{\"output_tokens\":12}}\n\n"
	second := "event: message_start\ndata: {\"type\":\"message_start\"}\n\n" +
		"event: content_block_delta\ndata: {\"delta\":{\"text\":\"完全不同的回答\"}}\n\n" +
		"event: message_delta\ndata: {\"usage\":{\"output_tokens\":998}}\n\n"

	if ResponseSignature(first) == "" {
		t.Fatal("流式响应应该能算出签名")
	}
	if similarity := SignatureSimilarity(ResponseSignature(first), ResponseSignature(second)); similarity != 1 {
		t.Fatalf("同结构不同内容应完全相似: %f", similarity)
	}
}

// 回答长短跟造不造假无关。次数进签名会让一个短回答和一个长回答看起来结构不同，
// 而抽检的错杀代价是摘掉一台诚实的机器 —— 这类噪声必须挡在门外。
func TestSignatureIgnoresResponseLength(t *testing.T) {
	short := "event: message_start\ndata: {}\n\nevent: content_block_delta\ndata: {}\n\n"
	long := "event: message_start\ndata: {}\n\n"
	for i := 0; i < 500; i++ {
		long += "event: content_block_delta\ndata: {}\n\n"
	}
	if similarity := SignatureSimilarity(ResponseSignature(short), ResponseSignature(long)); similarity != 1 {
		t.Fatalf("事件次数不该参与结构判定: %f", similarity)
	}
}

func TestSignatureCatchesMissingEvents(t *testing.T) {
	real := "event: message_start\ndata: {}\n\nevent: content_block_delta\ndata: {}\n\nevent: message_delta\ndata: {}\n\nevent: message_stop\ndata: {}\n\n"
	// 伪造者最容易漏的就是这个：只吐内容，不吐上游真正会发的那几个信封事件。
	forged := "event: content_block_delta\ndata: {}\n\n"
	similarity := SignatureSimilarity(ResponseSignature(real), ResponseSignature(forged))
	if similarity >= DefaultAuditConfig().ForgedBelow {
		t.Fatalf("缺了大半事件序列应判为伪造: %f", similarity)
	}
}

func TestJSONSignatureComparesShape(t *testing.T) {
	real := `{"id":"msg_1","type":"message","content":[{"type":"text","text":"甲"}],"usage":{"input_tokens":1,"output_tokens":2}}`
	same := `{"id":"msg_9","type":"message","content":[{"type":"text","text":"乙"}],"usage":{"input_tokens":9,"output_tokens":9}}`
	if similarity := SignatureSimilarity(ResponseSignature(real), ResponseSignature(same)); similarity != 1 {
		t.Fatalf("非流式响应同形状应完全相似: %f", similarity)
	}
	// 少了 usage 就意味着这次「回答」根本没经过上游的计量。
	missing := `{"id":"msg_9","type":"message","content":[{"type":"text","text":"乙"}]}`
	if similarity := SignatureSimilarity(ResponseSignature(real), ResponseSignature(missing)); similarity >= 1 {
		t.Fatal("缺少 usage 的响应不该判为完全一致")
	}
}

func TestSignatureSimilarityEdges(t *testing.T) {
	if SignatureSimilarity("", "") != 1 {
		t.Fatal("两边都没签名时无从判定，按一致处理，不冤枉人")
	}
	if SignatureSimilarity("a", "") != 0 {
		t.Fatal("一边有一边没有就是不一致")
	}
}

// 抽检比例是对提供者的承诺，不该由一行配置就能改成 100%。
func TestAuditRatioIsCappedAtOnePercent(t *testing.T) {
	svc := New(nil, Ports{Audit: AuditConfig{Ratio: 0.5, DailyCap: 5}}, NewKindRegistry(), Config{}).(*service)
	if svc.audit.Ratio != 0.01 {
		t.Fatalf("抽检比例应被封在 1%%: %f", svc.audit.Ratio)
	}
}

func TestProbeSkippedWithoutHubAccount(t *testing.T) {
	// 没有 Hub 自有账号就不抽检：拿被查者的凭据去查，结论没有意义。
	svc := New(nil, Ports{Audit: DefaultAuditConfig()}, NewKindRegistry(), Config{}).(*service)
	if svc.ShouldProbe(nil, "c1") {
		t.Fatal("没配重放账号时不该抽检")
	}
}
