package galaxy

import (
	"context"
	"strings"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 订单的运营视角。
//
// PayOrder（人工确认到账）一直都在，但**没有任何地方列得出订单** —— 运营手上是一个
// 渠道流水号，而那条接口要的是单号。两者之间没有桥，于是「线下转账」和「渠道回调丢了」
// 这两种补单场景实际上办不了，除非有人去库里 SELECT 一遍。
//
// 所以这一页的搜索必须认流水号，不能只认单号。

// AdminOrders 全站订单。
func (s *service) AdminOrders(ctx context.Context, query dto.AdminOrderQuery) (dto.AdminOrderPage, error) {
	limit := pageLimit(query.Limit, 20, 200)
	rows, total, err := s.repository.ListAdminOrders(ctx, repository.AdminOrderQuery{
		BizLine: bizLine, Status: strings.TrimSpace(query.Status),
		UserID: strings.TrimSpace(query.UserID), Keyword: strings.TrimSpace(query.Keyword),
		Offset: query.Offset, Limit: limit,
	})
	if err != nil {
		return dto.AdminOrderPage{}, err
	}
	counts, err := s.repository.CountOrdersByStatus(ctx, bizLine)
	if err != nil {
		return dto.AdminOrderPage{}, err
	}
	buyers := make([]string, 0, len(rows))
	for _, row := range rows {
		buyers = append(buyers, row.UserID)
	}
	// 买额度的是使用端的人，名字只可能在 consumer 那张账号表里。
	names, err := s.userNames(ctx, dto.SideConsumer, buyers)
	if err != nil {
		return dto.AdminOrderPage{}, err
	}
	page := dto.AdminOrderPage{Total: total, Counts: counts, Orders: make([]dto.AdminOrderView, 0, len(rows))}
	for _, row := range rows {
		page.Orders = append(page.Orders, dto.AdminOrderView{
			// secret 传空串：明文只在履约那一次返回，列表里永远不该出现它。
			OrderView:  orderView(row, ""),
			UserID:     row.UserID,
			UserName:   names[row.UserID],
			PaymentRef: row.PaymentRef,
		})
	}
	return page, nil
}
