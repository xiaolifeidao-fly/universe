package galaxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"contract"
	"gorm.io/gorm"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 争议工单（S-09）。
//
// 消费者和提供者互相看不见对方，出了问题两边没法自己谈 —— 平台是唯一同时握着
// 单元、计量和两本账的一方。所以争议只有一条路：消费者建单，运营裁决，追回或驳回。
//
// 「追回」不是把钱凭空还回去，是在三本账上各记一笔反向流水（设计文档 6.3 的
// refund / clawback / baddebt 三个类型），让账继续对得平。

const (
	disputeOpen      = "open"
	disputeReviewing = "reviewing"
	disputeUpheld    = "upheld"
	disputeRejected  = "rejected"
	disputeWithdrawn = "withdrawn"
)

// disputeWindow 建单期限。过了就不再受理 —— 否则提供者的积分永远处在
// 「随时可能被追回」的状态里，提现就没法结清。
const disputeWindow = 7 * 24 * time.Hour

var disputeReasons = map[string]bool{
	"not_delivered": true, // 什么都没产出
	"wrong_output":  true, // 产出明显不是要的东西
	"overcharged":   true, // 计量对不上
	"forged":        true, // 怀疑节点没真调上游
	"other":         true,
}

func (s *service) FileDispute(ctx context.Context, req dto.FileDisputeRequest) (dto.DisputeView, error) {
	if !disputeReasons[req.Reason] {
		return dto.DisputeView{}, errors.New("请选择一个申诉理由")
	}
	unit, err := s.repository.FindUnit(ctx, bizLine, req.UnitID)
	if notFound(err) {
		return dto.DisputeView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.DisputeView{}, err
	}
	if err := s.assertKeyOwner(ctx, req.OwnerUserID, unit.ConsumerKey, "执行记录"); err != nil {
		return dto.DisputeView{}, err
	}
	// 还没跑完的不受理：状态随时会变，这时候裁决没有意义。
	if !contract.UnitState(unit.State).Terminal() {
		return dto.DisputeView{}, errors.New("这次执行还没结束，结束后才能申诉")
	}
	if time.Since(unit.CreatedTime) > disputeWindow {
		return dto.DisputeView{}, fmt.Errorf("超过 %d 天的执行不再受理申诉", int(disputeWindow.Hours()/24))
	}

	row := &repository.GalaxyDispute{
		BizLine: bizLine, DisputeID: "dp_" + NewULID(time.Now()),
		UnitID: unit.UnitID, Attempt: unit.Attempt, Kind: unit.Kind,
		KeyID: unit.ConsumerKey, OwnerUserID: req.OwnerUserID, CID: unit.CID,
		ProviderUserID: s.contributionOwner(ctx, unit.CID),
		Reason:         req.Reason, Detail: truncate(strings.TrimSpace(req.Detail), 512),
		Status: disputeOpen,
	}
	if err := s.repository.CreateDispute(ctx, row); err != nil {
		// 唯一键撞车 = 这次执行已经有工单了。把已有那张返回去，比报个错有用。
		if existing, findErr := s.findDisputeByUnit(ctx, unit.UnitID, unit.Attempt); findErr == nil && existing != nil {
			return disputeView(existing), nil
		}
		return dto.DisputeView{}, err
	}
	return disputeView(row), nil
}

func (s *service) findDisputeByUnit(ctx context.Context, unitID string, attempt int) (*repository.GalaxyDispute, error) {
	rows, err := s.repository.ListDisputes(ctx, repository.DisputeQuery{BizLine: bizLine, UnitID: unitID, Limit: 20})
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if row.Attempt == attempt {
			return row, nil
		}
	}
	return nil, gorm.ErrRecordNotFound
}

// unitModel 这次执行调的是哪个模型。追回要按同一个模型的价算 ——
// 拿兜底价去退一笔按模型价收过的钱，退多退少都会挂在平台账上。
//
// 查不到（单元行被清掉了）就回落到空串，也就是该 kind 的兜底价：
// 和当初结算时单元行已经没了的情形一致。
func (s *service) unitModel(ctx context.Context, unitID string) string {
	row, err := s.repository.FindUnit(ctx, bizLine, unitID)
	if err != nil {
		return ""
	}
	return row.Model
}

func (s *service) contributionOwner(ctx context.Context, cid string) string {
	row, err := s.repository.FindContribution(ctx, bizLine, cid)
	if err != nil {
		return ""
	}
	return row.OwnerUserID
}

func (s *service) OwnedDisputes(ctx context.Context, ownerUserID string, limit int) ([]dto.DisputeView, error) {
	if strings.TrimSpace(ownerUserID) == "" {
		return nil, deniedByOwner("工单")
	}
	rows, err := s.repository.ListDisputes(ctx, repository.DisputeQuery{
		BizLine: bizLine, OwnerUserID: ownerUserID, Limit: clampLimit(limit),
	})
	if err != nil {
		return nil, err
	}
	return disputeViews(rows), nil
}

// WithdrawDispute 申诉人自己撤单。已经裁决过的撤不了。
func (s *service) WithdrawDispute(ctx context.Context, ownerUserID, disputeID string) error {
	row, err := s.repository.FindDispute(ctx, bizLine, disputeID)
	if notFound(err) {
		return contract.ErrNotFound
	}
	if err != nil {
		return err
	}
	if row.OwnerUserID != ownerUserID {
		return deniedByOwner("工单")
	}
	changed, err := s.repository.UpdateDisputeStatus(ctx, bizLine, disputeID,
		[]string{disputeOpen, disputeReviewing}, map[string]any{"status": disputeWithdrawn})
	if err != nil {
		return err
	}
	if !changed {
		return errors.New("这张工单已经处理过了")
	}
	return nil
}

// ---------- 运营侧 ----------

func (s *service) AdminDisputes(ctx context.Context, query dto.DisputeQuery) ([]dto.DisputeView, error) {
	rows, err := s.repository.ListDisputes(ctx, repository.DisputeQuery{
		BizLine: bizLine, Status: query.Status, CID: query.CID, Limit: clampLimit(query.Limit),
	})
	if err != nil {
		return nil, err
	}
	return disputeViews(rows), nil
}

// ResolveDispute 裁决。
//
// 状态推进用条件更新先抢，抢到了才动账 —— 两个运营同时点「支持申诉」时，
// 第二个人抢不到，钱只会退一次。
func (s *service) ResolveDispute(ctx context.Context, req dto.ResolveDisputeRequest) (dto.DisputeView, error) {
	row, err := s.repository.FindDispute(ctx, bizLine, req.DisputeID)
	if notFound(err) {
		return dto.DisputeView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.DisputeView{}, err
	}
	now := time.Now()

	if req.Status == disputeReviewing {
		changed, err := s.repository.UpdateDisputeStatus(ctx, bizLine, req.DisputeID,
			[]string{disputeOpen}, map[string]any{"status": disputeReviewing, "handled_by": req.HandledBy})
		if err != nil {
			return dto.DisputeView{}, err
		}
		if !changed {
			return dto.DisputeView{}, errors.New("这张工单已经处理过了")
		}
		return s.reloadDispute(ctx, req.DisputeID)
	}

	if req.Status != disputeUpheld && req.Status != disputeRejected {
		return dto.DisputeView{}, errors.New("裁决只能是支持、驳回或转入处理中")
	}

	values := map[string]any{
		"status": req.Status, "resolution": truncate(strings.TrimSpace(req.Resolution), 512),
		"handled_by": req.HandledBy, "handled_at": now,
	}
	// 驳回不动账，先写状态就行。支持申诉要先把追回算出来再一起写，
	// 否则抢到状态却算账失败，工单会停在「已支持但没退钱」上。
	var refund contract.Metering
	var clawback int64
	if req.Status == disputeUpheld {
		refund, clawback, err = s.planClawback(ctx, row)
		if err != nil {
			return dto.DisputeView{}, err
		}
		if len(refund) > 0 {
			values["refund_json"] = encodeJSON(refund)
		}
		values["clawback_amount"] = clawback
	}

	changed, err := s.repository.UpdateDisputeStatus(ctx, bizLine, req.DisputeID,
		[]string{disputeOpen, disputeReviewing}, values)
	if err != nil {
		return dto.DisputeView{}, err
	}
	if !changed {
		return dto.DisputeView{}, errors.New("这张工单已经处理过了")
	}
	if req.Status == disputeUpheld {
		if err := s.applyClawback(ctx, row, refund, clawback); err != nil {
			return dto.DisputeView{}, err
		}
	}
	return s.reloadDispute(ctx, req.DisputeID)
}

// planClawback 按计量流水和当时的定价算出该退多少、该追回多少。
// 不重新解析响应 —— 响应内容平台本来就不留。
func (s *service) planClawback(ctx context.Context, row *repository.GalaxyDispute) (contract.Metering, int64, error) {
	meters, err := s.repository.ListMeterRecords(ctx, bizLine, row.UnitID, row.Attempt)
	if err != nil {
		return nil, 0, err
	}
	if len(meters) == 0 {
		return nil, 0, nil
	}
	prices, err := s.priceTable(ctx, row.Kind, s.unitModel(ctx, row.UnitID), time.Now())
	if err != nil {
		return nil, 0, err
	}
	amounts := make(contract.Metering, len(meters))
	for _, meter := range meters {
		amounts[meter.Unit] += meter.Amount
	}
	refund, providerShare := clawbackPlan(amounts, prices)
	return refund, providerShare, nil
}

// clawbackPlan 从计量与定价算出「该退什么、该从提供者那儿追回多少」。
//
// 只退当初真收过钱的单位：calls 和 time 不计价（D-03），当初就没进账本，
// 退它等于凭空发钱。把这段单独拆出来是为了能直接拿数据验证 —— 它一错就是钱错。
func clawbackPlan(amounts contract.Metering, prices map[contract.MeterUnit]priceRow) (contract.Metering, int64) {
	refund := contract.Metering{}
	var providerShare int64
	for _, unit := range amounts.Units() {
		amount := amounts[unit]
		if amount <= 0 {
			continue
		}
		price, ok := prices[unit]
		if !ok || (price.Price <= 0 && price.ProviderPrice <= 0) {
			continue
		}
		cost, share := splitCost(amount, price)
		if cost <= 0 && share <= 0 {
			continue // 不足一个计价单位，当初也没收过钱
		}
		refund[unit] = amount
		providerShare += share
	}
	return refund, providerShare
}

// applyClawback 在三本账上各记一笔反向流水。
//
// 幂等键带上 :dispute 后缀：它和当初那笔 settle 是两条不同的流水，
// 对账时看得出来「这笔钱进来过又出去了」，而不是把原始记录抹掉。
func (s *service) applyClawback(ctx context.Context, row *repository.GalaxyDispute, refund contract.Metering, clawback int64) error {
	if len(refund) == 0 {
		return nil
	}
	prices, err := s.priceTable(ctx, row.Kind, s.unitModel(ctx, row.UnitID), time.Now())
	if err != nil {
		return err
	}
	consumer := make([]*repository.GalaxyConsumerLedger, 0, len(refund))
	provider := make([]*repository.GalaxyProviderLedger, 0, len(refund))
	var platformLoss, refundPoints int64
	for _, unit := range refund.Units() {
		amount := refund[unit]
		price := prices[unit]
		txn := fmt.Sprintf("%s:%d:%s:dispute", row.UnitID, row.Attempt, unit)
		consumer = append(consumer, &repository.GalaxyConsumerLedger{
			BizLine: bizLine, TxnID: txn, KeyID: row.KeyID, Type: "refund",
			Unit: unit, Amount: amount, Price: price.Price, UnitID: row.UnitID,
		})
		cost, share := splitCost(amount, price)
		refundPoints += cost
		// 追回记的和当初结算记的是同一个量纲：积分，不是计量数。
		// 两边不一致的话，对账时「进来过又出去了」这句话就对不平。
		provider = append(provider, &repository.GalaxyProviderLedger{
			BizLine: bizLine, TxnID: txn, CID: row.CID, OwnerUserID: row.ProviderUserID,
			Type: "clawback", Unit: unit, Amount: share, Price: settleUnitPrice(price), UnitID: row.UnitID,
		})
		platformLoss += cost - share
	}
	if err := s.repository.SaveConsumerLedger(ctx, consumer); err != nil {
		return err
	}
	if err := s.repository.SaveProviderLedger(ctx, provider); err != nil {
		return err
	}
	// 钱退回消费者的积分余额。退的是**当初按同一个算式收的那些**（splitCost），
	// 不是重新估一遍 —— 两处各算一次，只要取整差一点，退给使用者的和从
	// 提供者那儿追回的就对不上，差额会悄悄堆在平台账上。
	//
	// 退款按工单号幂等，所以同一张工单裁决两次也只退一笔。
	if refundPoints > 0 {
		if err := s.refundPoints(ctx, row, refundPoints); err != nil {
			return err
		}
	}
	if platformLoss > 0 {
		if err := s.repository.SavePlatformLedger(ctx, []*repository.GalaxyPlatformLedger{{
			BizLine: bizLine, TxnID: fmt.Sprintf("%s:%d:baddebt", row.UnitID, row.Attempt),
			Type: "baddebt", Amount: platformLoss, UnitID: row.UnitID,
		}}); err != nil {
			return err
		}
	}
	if clawback > 0 && row.ProviderUserID != "" {
		if err := s.repository.AddCredit(ctx, bizLine, row.ProviderUserID, -clawback); err != nil {
			return err
		}
	}
	// 这次执行带出去的邀请奖励一并退回。不退的话，一次伪造的执行能同时套出两笔钱：
	// 提供者那笔被追回了，邀请人那笔还留在账上。
	s.clawbackProviderReferral(ctx, row)
	// 伪造被坐实按设计文档 6.2 清零信誉，其它成立的申诉只扣一点。
	// 分开是因为这两件事性质不同：一个是作弊，一个是没干好。
	if row.CID != "" {
		delta := -0.1
		if row.Reason == "forged" {
			delta = -1
		}
		_ = s.adjustReputation(ctx, row.CID, delta)
	}
	return nil
}

// refundPoints 把一笔坐实的争议退回使用者的积分余额。
//
// 退给**密钥的主人**，不是密钥：余额本来就挂在账户上，而那把密钥可能早就吊销了 ——
// 退到一把用不了的密钥上，等于没退。
func (s *service) refundPoints(ctx context.Context, row *repository.GalaxyDispute, amount int64) error {
	key, err := s.repository.FindConsumerKey(ctx, bizLine, row.KeyID)
	if err != nil {
		return err
	}
	if key.OwnerUserID == "" {
		return fmt.Errorf("密钥 %s 没有主人，退款无处可退", row.KeyID)
	}
	_, err = s.applyPoints(ctx, &repository.GalaxyPointsLedger{
		BizLine: bizLine, TxnID: "dispute:" + row.DisputeID + ":refund", OwnerUserID: key.OwnerUserID,
		Type: dto.PointsRefund, Amount: amount, BaseAmount: amount,
		UnitID: row.UnitID, Kind: row.Kind,
	}, false, nil)
	return err
}

func (s *service) reloadDispute(ctx context.Context, disputeID string) (dto.DisputeView, error) {
	row, err := s.repository.FindDispute(ctx, bizLine, disputeID)
	if err != nil {
		return dto.DisputeView{}, err
	}
	return disputeView(row), nil
}

func disputeViews(rows []*repository.GalaxyDispute) []dto.DisputeView {
	views := make([]dto.DisputeView, 0, len(rows))
	for _, row := range rows {
		views = append(views, disputeView(row))
	}
	return views
}

// disputeView 刻意不带 providerUserId：消费者看不到提供者是谁，
// 运营看 cid 就够了 —— 需要人的时候从贡献查，不在工单列表里直接摊开。
func disputeView(row *repository.GalaxyDispute) dto.DisputeView {
	view := dto.DisputeView{
		DisputeID: row.DisputeID, UnitID: row.UnitID, Attempt: row.Attempt, Kind: row.Kind,
		KeyID: row.KeyID, CID: row.CID, Reason: row.Reason, Detail: row.Detail,
		Status: row.Status, Resolution: row.Resolution, ClawbackAmount: row.ClawbackAmount,
		HandledBy: row.HandledBy, HandledAt: row.HandledAt,
		CreatedTime: row.CreatedTime, UpdatedTime: row.UpdatedTime,
	}
	if row.RefundJSON != "" {
		var refund contract.Metering
		if err := json.Unmarshal([]byte(row.RefundJSON), &refund); err == nil {
			view.Refund = refund
		}
	}
	return view
}
