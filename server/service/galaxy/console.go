package galaxy

import (
	"context"
	"strings"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 控制台只读接口：按「人」查会话与任务。
//
// /v1/* 那套按 sk- 算力密钥授权，控制台拿的却是用户令牌，中间隔着「一个人名下有
// 好几把密钥」这一层。与其让控制台先列密钥、再逐把去 /v1/ 拉一遍（N+1，而且要把
// 明文密钥交给浏览器 —— 明文只在签发那一次给），不如单独一组按 owner 过滤的只读
// 接口：授权依据只有一个，就是令牌里的用户 id。

// deniedByOwner 是这组接口唯一的拒绝理由：东西存在，但不是你的。
func deniedByOwner(what string) error {
	return contract.NewUnitError(contract.ErrorClassBilling, contract.CodeScopeDenied, false, "无权访问该"+what)
}

// ownedKeys 解析这个人名下的全部密钥 id。
//
// 返回空切片表示「一把都没有」。调用方必须据此直接返回空结果 —— 空切片进了
// `WHERE consumer_key IN ?` 就等于没有这个条件，会把全站的会话交给一个连密钥都
// 没有的人。所以这里返回 (nil, nil)，每个调用方开头都显式挡一次。
func (s *service) ownedKeys(ctx context.Context, ownerUserID string) ([]string, error) {
	ownerUserID = strings.TrimSpace(ownerUserID)
	if ownerUserID == "" {
		return nil, deniedByOwner("数据")
	}
	rows, err := s.repository.ListConsumerKeys(ctx, bizLine, ownerUserID)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(rows))
	for _, row := range rows {
		keys = append(keys, row.KeyID)
	}
	return keys, nil
}

// scopeKeys 把「这人的全部密钥」和「只看某一把」求交。
// 指定的那把不在名下时返回 nil —— 等价于查不到，而不是放行。
func (s *service) scopeKeys(ctx context.Context, ownerUserID, keyID string) ([]string, error) {
	keys, err := s.ownedKeys(ctx, ownerUserID)
	if err != nil {
		return nil, err
	}
	return narrowKeys(keys, keyID), nil
}

// narrowKeys 求「名下全部密钥」与「只看这一把」的交集。
//
// 单独拆出来是因为它有三个容易写反的边界，每一个写反都是越权：
// 名下没有密钥 → 空（不是"不过滤"）；指定的那把不在名下 → 空（不是"忽略这个条件"）；
// 没有指定 → 全部名下的（不是空）。
func narrowKeys(owned []string, keyID string) []string {
	keyID = strings.TrimSpace(keyID)
	if keyID == "" {
		return owned
	}
	for _, key := range owned {
		if key == keyID {
			return []string{key}
		}
	}
	return nil
}

func (s *service) OwnedSessions(ctx context.Context, query dto.WorkloadQuery) ([]dto.SessionView, error) {
	keys, err := s.scopeKeys(ctx, query.OwnerUserID, query.KeyID)
	if err != nil {
		return nil, err
	}
	if len(keys) == 0 {
		return []dto.SessionView{}, nil
	}
	rows, err := s.repository.ListSessions(ctx, repository.SessionQuery{
		BizLine: bizLine, ConsumerKeys: keys,
		Kind: query.Kind, State: query.State, Limit: clampLimit(query.Limit),
	})
	if err != nil {
		return nil, err
	}
	views := make([]dto.SessionView, 0, len(rows))
	for _, row := range rows {
		views = append(views, sessionView(row))
	}
	return views, nil
}

func (s *service) OwnedSessionContext(ctx context.Context, ownerUserID, sid string, fromSeq int) (dto.SessionContextView, error) {
	if err := s.assertSessionOwner(ctx, ownerUserID, sid); err != nil {
		return dto.SessionContextView{}, err
	}
	return s.SessionContext(ctx, sid, fromSeq)
}

func (s *service) assertSessionOwner(ctx context.Context, ownerUserID, sid string) error {
	row, err := s.repository.FindSession(ctx, bizLine, sid)
	if notFound(err) {
		return contract.ErrNotFound
	}
	if err != nil {
		return err
	}
	return s.assertKeyOwner(ctx, ownerUserID, row.ConsumerKey, "会话")
}

// assertKeyOwner 判「这条记录用的密钥，是不是这个人的」。
// 找不到那把密钥（已吊销并清理）时同样拒绝：宁可少给，不能多给。
func (s *service) assertKeyOwner(ctx context.Context, ownerUserID, consumerKey, what string) error {
	keys, err := s.ownedKeys(ctx, ownerUserID)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if key == consumerKey {
			return nil
		}
	}
	return deniedByOwner(what)
}

func (s *service) OwnedJobs(ctx context.Context, query dto.WorkloadQuery) ([]dto.JobView, error) {
	keys, err := s.scopeKeys(ctx, query.OwnerUserID, query.KeyID)
	if err != nil {
		return nil, err
	}
	if len(keys) == 0 {
		return []dto.JobView{}, nil
	}
	rows, _, err := s.repository.ListUnits(ctx, repository.UnitQuery{
		BizLine: bizLine, ConsumerKeys: keys, Kind: query.Kind,
		Primitive: string(contract.PrimitiveJob), Limit: clampLimit(query.Limit),
	})
	if err != nil {
		return nil, err
	}
	views := make([]dto.JobView, 0, len(rows))
	for _, row := range rows {
		view, err := s.jobView(ctx, row)
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	return views, nil
}

func (s *service) OwnedJob(ctx context.Context, ownerUserID, jobID string) (dto.JobView, error) {
	row, err := s.repository.FindUnit(ctx, bizLine, jobID)
	if notFound(err) {
		return dto.JobView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.JobView{}, err
	}
	if err := s.assertKeyOwner(ctx, ownerUserID, row.ConsumerKey, "任务"); err != nil {
		return dto.JobView{}, err
	}
	return s.jobView(ctx, row)
}

// OwnedUnitEvents 让控制台看到一个单元的事件流。任务跑几小时，进度与产物都在
// 事件里 —— 没有它，控制台只能看到一个不动的「running」。
func (s *service) OwnedUnitEvents(ctx context.Context, ownerUserID, unitID string, fromSeq int) ([]UnitEventView, error) {
	row, err := s.repository.FindUnit(ctx, bizLine, unitID)
	if notFound(err) {
		return nil, contract.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := s.assertKeyOwner(ctx, ownerUserID, row.ConsumerKey, "任务"); err != nil {
		return nil, err
	}
	return s.ListUnitEvents(ctx, unitID, fromSeq)
}

// OwnedCloseSession 控制台手动关掉一个会话，把它钉着的座位还给池子。
func (s *service) OwnedCloseSession(ctx context.Context, ownerUserID, sid, reason string) error {
	if err := s.assertSessionOwner(ctx, ownerUserID, sid); err != nil {
		return err
	}
	return s.CloseSession(ctx, dto.CloseSessionRequest{SID: sid, Reason: defaultString(reason, "closed_by_console")})
}

// OwnedCancelJob 控制台撤一个还没跑完的任务。
func (s *service) OwnedCancelJob(ctx context.Context, ownerUserID, jobID string) error {
	row, err := s.repository.FindUnit(ctx, bizLine, jobID)
	if notFound(err) {
		return contract.ErrNotFound
	}
	if err != nil {
		return err
	}
	if err := s.assertKeyOwner(ctx, ownerUserID, row.ConsumerKey, "任务"); err != nil {
		return err
	}
	return s.CancelJob(ctx, jobID, "")
}

func clampLimit(limit int) int {
	if limit <= 0 || limit > 200 {
		return 50
	}
	return limit
}

// OwnedUsage 控制台的用量账单。
//
// 与 Usage 有两处差别。一处是安全边界：统计范围由令牌解析出的密钥集合决定，
// 不由请求参数决定，请求里的 keyId 只能在这个集合内做进一步收窄。
// 另一处是口径：这一路只摆计价行，见下。
func (s *service) OwnedUsage(ctx context.Context, ownerUserID string, query dto.UsageQuery) (dto.UsageReport, error) {
	keys, err := s.scopeKeys(ctx, ownerUserID, query.ConsumerKey)
	if err != nil {
		return dto.UsageReport{}, err
	}
	if len(keys) == 0 {
		return dto.UsageReport{From: query.From, To: query.To, Currency: "CNY"}, nil
	}
	query.ConsumerKey = ""
	query.ConsumerKeys = keys
	report, err := s.Usage(ctx, query)
	if err != nil {
		return dto.UsageReport{}, err
	}
	report.Lines = pricedLines(report.Lines)
	return report, nil
}

// pricedLines 只留下真的有单价的行。
//
// 使用端那张表是**账单**：每一行都该是一笔钱。不计价的单位（llm.calls、
// time.seconds、llm.total_tokens、没配价的缓存写桶）能占到一半以上的行，
// 而它们的单价和扣费两列全是「-」—— 回答的是「跑了多少量」而不是「花了多少钱」，
// 却把真正收了钱的那几行挤到了要滚动才看得到的地方。量没有丢：逐笔那一页
// 点开任意一行，明细里所有单位都还在。
//
// 判据是**有没有单价**，不是这一行收了多少：单价乘以量向下取整到微元，
// 小额确实会落到 0，但那是「这笔太小，显示成 0」，不是「这一项不收钱」——
// 按扣费筛会把它们跟不计价的混成一类。
//
// 合计不受影响：摘掉的行 Cost 恒为 0，本来就没加进 TotalFee。
func pricedLines(lines []dto.UsageLine) []dto.UsageLine {
	priced := make([]dto.UsageLine, 0, len(lines))
	for _, line := range lines {
		if line.UnitPrice > 0 {
			priced = append(priced, line)
		}
	}
	return priced
}
