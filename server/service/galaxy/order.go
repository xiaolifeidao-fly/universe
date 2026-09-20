package galaxy

import (
	"encoding/json"
	"strings"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 订单：只剩**读历史**。
//
// 额度包卖的是「一把密钥里的 token 额度」。改成按账户积分余额逐笔扣费之后
// 这门生意没有了 —— 使用端不再下单，运营也不再维护商品目录，支付渠道与沙箱支付
// 一并下线。表和这一段留着，是因为运营那份订单列表要摆得出「当初这个人买过什么」。
//
// 密钥的类别判定（scopeCategory）也留在这里：它原先是给商品分栏用的，
// 现在只服务于密钥 —— 「这把该接 Claude Code 还是 Codex」是同一个问题。

// 订单状态与支付方式的词汇表。没有新订单会用到它们，读旧行时要认得出。
const (
	orderPending   = "pending"
	orderPaid      = "paid"
	orderFulfilled = "fulfilled"
	orderCancelled = "cancelled"

	payByPoints  = "points"
	payByChannel = "channel"
)

func decodePackageItems(raw string) []dto.PackageItem {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []dto.PackageItem
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

// scopeCategory 一把密钥属于哪一类算力：claude / codex / video / other。
//
// 按模型档而不是按 kind 分：llm.chat 下面同时有 Claude 和 Codex，光看 kind
// 会把两类堆进同一栏。模型档没说清楚时再看绑定的模型。两样都没有（范围不限）的
// 归 other：它什么都能用，硬塞进某一栏反而是错的 —— 自助签发的密钥就是这一类。
//
// 密钥页的「使用」按钮按它决定写 Claude Code 还是 Codex 的配置，所以规则只在这一处。
func scopeCategory(kinds, tiers []string, modelID string) string {
	for _, kind := range kinds {
		if strings.HasPrefix(kind, "video.") {
			return "video"
		}
	}
	for _, tier := range tiers {
		switch pattern := strings.ToLower(tier); {
		case strings.HasPrefix(pattern, "claude"):
			return "claude"
		case strings.HasPrefix(pattern, "gpt"), strings.HasPrefix(pattern, "o1"), strings.Contains(pattern, "codex"):
			return "codex"
		}
	}
	if strings.TrimSpace(modelID) != "" {
		family, _ := inferFamily(modelID)
		return familyCategory(family)
	}
	return "other"
}

// familyCategory 模型族 → 使用端的类别。gpt 一族在使用端叫 codex：Orbit 上接它的就是 Codex CLI。
func familyCategory(family string) string {
	switch family {
	case "claude":
		return "claude"
	case "gpt":
		return "codex"
	default:
		return "other"
	}
}

func orderView(row *repository.GalaxyOrder, secret string) dto.OrderView {
	return dto.OrderView{
		OrderID: row.OrderID, PackageCode: row.PackageCode, Units: decodeMetering(row.UnitsJSON),
		Items:  decodePackageItems(row.ItemsJSON),
		Amount: row.Amount, Currency: row.Currency, Status: row.Status,
		PayMethod: defaultString(row.PayMethod, payByChannel), ModelID: row.ModelID,
		TargetKeyID: row.TargetKeyID, KeyID: row.KeyID,
		PaidAt: row.PaidAt, FulfilledAt: row.FulfilledAt, CreatedTime: row.CreatedTime,
		IssuedSecret: secret,
	}
}
