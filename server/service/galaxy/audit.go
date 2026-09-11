package galaxy

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"sort"
	"strings"
	"time"

	"contract"
	"service/galaxy/internal/repository"
)

// 抽检（S-08 / 设计文档 13）。
//
// 要防的是一件很具体的事：节点可以根本不调上游，自己编一段像模像样的响应回来，
// 照样按 token 收钱。消费者未必看得出来，Hub 更看不出来 —— 除非自己也去调一次。
//
// 所以每个贡献每天随机抽不超过 1% 的请求，用 Hub 自有账号原样重放一次，
// 比对**结构**而不是内容：同一个提问两次回答本来就不一样，但事件序列、
// 字段形状、用量量级是可比的。差得太远就记一次，累计两次摘除。

const (
	verdictPending = "pending"
	verdictReady   = "ready"
	verdictPass    = "pass"
	verdictSuspect = "suspect"
	verdictForged  = "forged"

	// probeBodyTTL 抽检留着的请求原文最多存这么久。
	probeBodyTTL = 24 * time.Hour
	// forgedThreshold 累计几次伪造判定就摘除这条贡献。
	forgedThreshold = 2
)

// AuditConfig 抽检参数。Ratio 为 0 表示关掉抽检。
type AuditConfig struct {
	// Ratio 抽样比例，上限 1%/贡献/日。
	Ratio float64
	// DailyCap 每个贡献每天最多抽几次，防止低流量贡献被反复抽。
	DailyCap int
	// SuspectBelow / ForgedBelow 结构相似度低于它们分别记可疑与伪造。
	SuspectBelow float64
	ForgedBelow  float64
}

func DefaultAuditConfig() AuditConfig {
	return AuditConfig{Ratio: 0.01, DailyCap: 20, SuspectBelow: 0.6, ForgedBelow: 0.3}
}

// ShouldProbe 决定这次请求要不要抽检。两道闸：随机比例 + 每日上限。
// 上限是必须的 —— 低流量贡献一天只有几十个请求，纯按比例会把它抽成高频。
func (s *service) ShouldProbe(ctx context.Context, cid string) bool {
	if s.audit.Ratio <= 0 || s.replayer == nil {
		return false
	}
	if rand.Float64() >= s.audit.Ratio {
		return false
	}
	count, err := s.control.BumpProbeBudget(ctx, cid, time.Now().Format("20060102"))
	if err != nil {
		return false
	}
	return count <= int64(s.audit.DailyCap)
}

// RecordProbe 记下一次抽检样本。请求原文短期保留，只为能重放一次。
func (s *service) RecordProbe(ctx context.Context, unit contract.WorkUnit, cid string) error {
	body, ok := unit.InlineInput("body")
	if !ok || len(body) == 0 {
		return nil
	}
	path, _ := unit.InlineInput("path")
	return s.repository.CreateAuditProbe(ctx, &repository.GalaxyAuditProbe{
		BizLine: bizLine, ProbeID: "p_" + NewULID(time.Now()), CID: cid, UnitID: unit.ID,
		Family: unit.Family, Path: string(path), Model: unit.Model,
		RequestBody: string(body), Verdict: verdictPending,
	})
}

// markProbeReady 节点那次跑完了：记下它的响应签名，这条抽检就可以去重放比对了。
func (s *service) markProbeReady(ctx context.Context, unitID, signature string) {
	if signature == "" {
		return
	}
	row, err := s.repository.FindAuditProbeByUnit(ctx, bizLine, unitID)
	if err != nil || row.Verdict != verdictPending {
		return
	}
	_ = s.repository.UpdateAuditProbe(ctx, bizLine, row.ProbeID, map[string]any{
		"node_signature": truncate(signature, 1024), "verdict": verdictReady,
	})
}

// RunProbes 跑一批待比对的抽检。定时任务调用，不在请求路径上 ——
// 重放要花和原请求一样久的时间，挂在消费者那条链路上等于把延迟翻倍。
func (s *service) RunProbes(ctx context.Context, limit int) (int, error) {
	if s.replayer == nil {
		return 0, nil
	}
	// 先把超期没跑的样本的原文清掉：留着它的理由已经消失了。
	_ = s.repository.PurgeStaleProbeBodies(ctx, bizLine, time.Now().Add(-probeBodyTTL))

	rows, err := s.repository.ListReadyProbes(ctx, bizLine, limit)
	if err != nil {
		return 0, err
	}
	done := 0
	for _, row := range rows {
		if err := s.runProbe(ctx, row); err != nil {
			_ = s.repository.UpdateAuditProbe(ctx, bizLine, row.ProbeID, map[string]any{
				"verdict": "skipped", "detail": truncate(err.Error(), 512), "request_body": "",
				"checked_at": time.Now(),
			})
			continue
		}
		done++
	}
	return done, nil
}

func (s *service) runProbe(ctx context.Context, row *repository.GalaxyAuditProbe) error {
	if row.RequestBody == "" {
		return fmt.Errorf("样本原文已过期")
	}
	shadow, err := s.replayer.Replay(ctx, row.Family, row.Path, []byte(row.RequestBody))
	if err != nil {
		return err
	}
	shadowSignature := ResponseSignature(shadow)
	similarity := SignatureSimilarity(row.NodeSignature, shadowSignature)

	verdict := verdictPass
	switch {
	case similarity < s.audit.ForgedBelow:
		verdict = verdictForged
	case similarity < s.audit.SuspectBelow:
		verdict = verdictSuspect
	}
	now := time.Now()
	if err := s.repository.UpdateAuditProbe(ctx, bizLine, row.ProbeID, map[string]any{
		"shadow_signature": truncate(shadowSignature, 1024), "similarity": similarity,
		"verdict": verdict, "checked_at": now,
		// 比对完了就把原文删掉：留着它的唯一理由已经用掉了。
		"request_body": "",
	}); err != nil {
		return err
	}

	s.metrics.Count(MetricAuditVerdict, map[string]string{"cid": row.CID, "verdict": verdict}, 1)
	switch verdict {
	case verdictSuspect:
		_ = s.adjustReputation(ctx, row.CID, -0.1)
	case verdictForged:
		_ = s.adjustReputation(ctx, row.CID, -0.5)
		forged, err := s.repository.CountVerdicts(ctx, bizLine, row.CID, verdictForged, now.AddDate(0, 0, -30))
		if err == nil && forged >= forgedThreshold {
			// 累计两次就摘除：一次可能是上游抖动，两次就是这台机器在编。
			_ = s.repository.SetContributionStatus(ctx, bizLine, row.CID, statusDisabled)
			_ = s.control.SetDraining(ctx, row.CID, true)
			if s.notifier != nil {
				if contribution, err := s.repository.FindContribution(ctx, bizLine, row.CID); err == nil {
					s.notifier.NotifyContributionRemoved(ctx, contribution.OwnerUserID, row.CID, "抽检判定响应造假")
				}
			}
		}
	}
	return nil
}

// ResponseSignature 把一段响应压成结构签名。
//
// 比的是结构不是内容：同一个提问两次回答本来就不一样，但事件类型的序列、
// JSON 的键路径、用量的量级是可比的。伪造者要么造不出正确的事件序列，
// 要么造得出但用量对不上。
func ResponseSignature[T ~string | ~[]byte](raw T) string {
	text := string(raw)
	if strings.Contains(text, "event:") || strings.Contains(text, "data:") {
		return sseSignature(text)
	}
	return jsonSignature([]byte(text))
}

// sseSignature 只记出现过哪些事件类型，不记各出现了几次。
//
// 次数是噪声：同一个提问，回答 5 个 token 和 500 个 token 的 content_block_delta
// 数量差两个量级，但两者都是真实响应。把次数放进签名会让诚实的提供者被误判 ——
// 抽检的错杀代价（摘掉一台好机器）比漏杀高得多。
//
// 真正的信号是「这段响应有没有上游才会发的那几个信封事件」：
// 编出来的响应通常只有内容事件，缺 message_start / message_delta / response.completed
// 这些带元数据的封套。
func sseSignature(text string) string {
	seen := map[string]struct{}{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "event:") {
			continue
		}
		if name := strings.TrimSpace(strings.TrimPrefix(line, "event:")); name != "" {
			seen[name] = struct{}{}
		}
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return strings.Join(names, ",")
}

func jsonSignature(raw []byte) string {
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "invalid"
	}
	paths := map[string]struct{}{}
	collectPaths("", payload, paths, 0)
	names := make([]string, 0, len(paths))
	for path := range paths {
		names = append(names, path)
	}
	sort.Strings(names)
	return strings.Join(names, ",")
}

func collectPaths(prefix string, value any, out map[string]struct{}, depth int) {
	if depth > 6 || len(out) > 200 {
		return
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			path := key
			if prefix != "" {
				path = prefix + "." + key
			}
			out[path] = struct{}{}
			collectPaths(path, child, out, depth+1)
		}
	case []any:
		// 数组只看第一个元素的形状：长度取决于内容，不该参与结构判定。
		if len(typed) > 0 {
			collectPaths(prefix+"[]", typed[0], out, depth+1)
		}
	}
}

// SignatureSimilarity 两个签名的 Jaccard 相似度。
func SignatureSimilarity(left, right string) float64 {
	leftSet := splitSignature(left)
	rightSet := splitSignature(right)
	if len(leftSet) == 0 && len(rightSet) == 0 {
		return 1
	}
	if len(leftSet) == 0 || len(rightSet) == 0 {
		return 0
	}
	intersection := 0
	for token := range leftSet {
		if _, ok := rightSet[token]; ok {
			intersection++
		}
	}
	union := len(leftSet) + len(rightSet) - intersection
	if union == 0 {
		return 1
	}
	return float64(intersection) / float64(union)
}

func splitSignature(value string) map[string]struct{} {
	out := map[string]struct{}{}
	for _, token := range strings.Split(value, ",") {
		if token = strings.TrimSpace(token); token != "" {
			out[token] = struct{}{}
		}
	}
	return out
}
