package galaxy

import (
	"context"
	"errors"
	"strings"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 用量偏差与运行工单：两块此前在管理端完全看不到的东西。
//
// 用量偏差表（zt_galaxy_usage_mismatch）**只写不读** —— 节点自报和 Hub 解析对不上
// 就落一行，然后没有任何地方看得见它。于是「某台机器一直在虚报用量」这件事，
// 在库里有据可查，在管理端查不出来，最后只会以「账对不上」的形式冒出来。
//
// 运行工单（zt_galaxy_unit）有按人查的路（OwnedJobs / OwnedUsageRecords），
// 但运营没有跨租户的那条：「现在池子里在跑什么」「刚才那一批为什么全失败了」
// 这两个排障问题，此前只能进库 SELECT。

const (
	// mismatchDefaultDays 偏差列表默认往回看几天。
	mismatchDefaultDays = 7
	// unitDefaultDays 运行工单默认往回看几天。排障用的，翻太久没有意义。
	unitDefaultDays = 1
)

// AdminMismatches 用量偏差列表 + 反复上榜的贡献排行。
func (s *service) AdminMismatches(ctx context.Context, query dto.MismatchQuery) (dto.MismatchPage, error) {
	days := query.Days
	if days <= 0 {
		days = mismatchDefaultDays
	}
	scope := repository.MismatchQuery{
		BizLine: bizLine, CID: strings.TrimSpace(query.CID), Unit: strings.TrimSpace(query.Unit),
		MinRatio: query.MinRatio, From: time.Now().AddDate(0, 0, -days),
		Offset: query.Offset, Limit: pageLimit(query.Limit, 20, 200),
	}
	rows, total, err := s.repository.ListUsageMismatches(ctx, scope)
	if err != nil {
		return dto.MismatchPage{}, err
	}
	// 排行按**整个筛选条件**算，不是当前这一页 —— 一页 20 条里数出来的「最多」没有意义。
	offenders, err := s.repository.CountMismatchesByCID(ctx, scope, 10)
	if err != nil {
		return dto.MismatchPage{}, err
	}

	names, err := s.contributionOwnerNames(ctx, cidsOfMismatch(rows, offenders))
	if err != nil {
		return dto.MismatchPage{}, err
	}

	page := dto.MismatchPage{
		Total: total, Threshold: s.cfg().UsageMismatchRatio, Days: days,
		Records:   make([]dto.UsageMismatchView, 0, len(rows)),
		Offenders: make([]dto.MismatchOffender, 0, len(offenders)),
	}
	for _, row := range rows {
		page.Records = append(page.Records, dto.UsageMismatchView{
			UnitID: row.UnitID, CID: row.CID, OwnerName: names[row.CID], Unit: row.Unit,
			HubValue: row.HubValue, NodeValue: row.NodeValue, Ratio: row.Ratio, CreatedAt: row.CreatedAt,
		})
	}
	for _, row := range offenders {
		page.Offenders = append(page.Offenders, dto.MismatchOffender{
			CID: row.CID, OwnerName: names[row.CID], Times: row.Times, WorstRatio: row.WorstRatio,
		})
	}
	return page, nil
}

func cidsOfMismatch(rows []*repository.GalaxyUsageMismatch, offenders []repository.MismatchCount) []string {
	cids := make([]string, 0, len(rows)+len(offenders))
	for _, row := range rows {
		cids = append(cids, row.CID)
	}
	for _, row := range offenders {
		cids = append(cids, row.CID)
	}
	return cids
}

// contributionOwnerNames 这些贡献各自的主人叫什么，按 cid 索引。
//
// 贡献行上存的是 owner_user_id，而运营要看的是名字 —— 一串 pu_01J… 认不出是谁，
// 于是「哪台机器在虚报」这个结论落不到人头上。
func (s *service) contributionOwnerNames(ctx context.Context, cids []string) (map[string]string, error) {
	byCID := map[string]string{}
	ownerOf, err := s.repository.ContributionOwnersByCIDs(ctx, bizLine, uniqueStrings(cids))
	if err != nil || len(ownerOf) == 0 {
		return byCID, err
	}
	owners := make([]string, 0, len(ownerOf))
	for _, owner := range ownerOf {
		owners = append(owners, owner)
	}
	names, err := s.userNames(ctx, dto.SideProvider, owners)
	if err != nil {
		return byCID, err
	}
	for cid, owner := range ownerOf {
		byCID[cid] = names[owner]
	}
	return byCID, nil
}

// AdminUnits 运行工单：池子里此刻在跑什么、刚才那一批为什么失败。
func (s *service) AdminUnits(ctx context.Context, query dto.AdminUnitQuery) (dto.AdminUnitPage, error) {
	days := query.Days
	if days <= 0 {
		days = unitDefaultDays
	}
	since := time.Now().AddDate(0, 0, -days)
	rows, total, err := s.repository.ListUnits(ctx, repository.UnitQuery{
		BizLine: bizLine, State: strings.TrimSpace(query.State), Kind: strings.TrimSpace(query.Kind),
		CID: strings.TrimSpace(query.CID), ConsumerKey: strings.TrimSpace(query.ConsumerKey),
		From: since, Offset: query.Offset, Limit: pageLimit(query.Limit, 20, 200),
	})
	if err != nil {
		return dto.AdminUnitPage{}, err
	}
	counts, err := s.repository.CountUnitsByState(ctx, bizLine, since)
	if err != nil {
		return dto.AdminUnitPage{}, err
	}

	// 分组名一次解完：工单页上要显示「标准 / 深度」，库里存的是 mg_…。
	groupNames := s.groupNames(ctx)

	page := dto.AdminUnitPage{Total: total, Counts: counts, Days: days, Units: make([]dto.AdminUnitView, 0, len(rows))}
	for _, row := range rows {
		view := dto.AdminUnitView{
			UnitID: row.UnitID, Kind: row.Kind, Primitive: row.Primitive, Provider: row.Provider,
			Model: row.Model, GroupID: row.GroupID, GroupName: groupNames[row.GroupID],
			Effort: row.Effort, Fast: row.Fast,
			ConsumerKey: row.ConsumerKey, CID: row.CID, State: row.State,
			ErrorClass: row.ErrorClass, ErrorCode: row.ErrorCode, ErrorMsg: row.ErrorMsg,
			Instance: row.Instance, Attempt: row.Attempt,
			StartedAt: row.StartedAt, FinishedAt: row.FinishedAt, CreatedTime: row.CreatedTime,
		}
		if row.StartedAt != nil && row.FinishedAt != nil {
			view.DurationMs = row.FinishedAt.Sub(*row.StartedAt).Milliseconds()
		}
		page.Units = append(page.Units, view)
	}
	return page, nil
}

// AdminCancelUnit 运营强制取消一条还在跑的工单。
//
// 取消是**请求**不是命令（原则 8）：标记搭在节点已有的长轮询上下发，真正 abort 上游的是节点。
// 所以这里只做两件事 —— 在事件流上留一笔谁取消的、为什么，然后把标记写进控制面。
//
// 已经到终态的不再受理：那条请求早就结束了，写一个取消标记只会在事件流上留下
// 一条误导后来人的记录（看着像「是被运营取消的」，其实是自己跑完的）。
func (s *service) AdminCancelUnit(ctx context.Context, req dto.CancelUnitRequest) error {
	unitID := strings.TrimSpace(req.UnitID)
	if unitID == "" {
		return errors.New("缺少要取消的工单")
	}
	row, err := s.repository.FindUnit(ctx, bizLine, unitID)
	if notFound(err) {
		return contract.ErrNotFound
	}
	if err != nil {
		return err
	}
	if contract.UnitState(row.State).Terminal() {
		return errors.New("这条工单已经结束了，取消不了")
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		reason = "operator_cancelled"
	}
	// 留痕先于动作：控制面写成功而事件没记上，之后没人说得清这条是被谁取消的。
	_ = s.repository.AppendUnitEvent(ctx, &repository.GalaxyUnitEvent{
		BizLine: bizLine, UnitID: unitID, Kind: "cancel_requested",
		Message: truncate(req.CancelledBy+": "+reason, 512),
	})
	return s.control.RequestCancel(ctx, unitID, reason)
}
