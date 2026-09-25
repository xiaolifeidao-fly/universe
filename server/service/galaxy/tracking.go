package galaxy

import (
	"context"
	"errors"
	"strings"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// RecordTrackingEvent 记录一个受支持的位置事件。
// 时间只认服务端，避免客户端时钟错误或伪造日期把历史趋势改掉。
func (s *service) RecordTrackingEvent(ctx context.Context, eventKey, targetKey string) error {
	eventKey = strings.TrimSpace(eventKey)
	targetKey = strings.TrimSpace(targetKey)
	switch eventKey {
	case dto.TrackingEventPortalOpen:
		targetKey = ""
	case dto.TrackingEventModelSquareClick:
		if targetKey == "" {
			return errors.New("模型标识不能为空")
		}
		if len(targetKey) > 96 {
			return errors.New("模型标识过长")
		}
	default:
		return errors.New("不支持的埋点事件")
	}

	now := time.Now()
	return s.repository.IncrementTrackingDaily(ctx, &repository.GalaxyTrackingDaily{
		BizLine: bizLine, EventDate: startOfDay(now), EventKey: eventKey, TargetKey: targetKey,
		Count: 1, CreatedTime: now, UpdatedTime: now,
	})
}

// dashboardTracking 只返回所选的一天。日期由管理端明确传入，服务端按自己的时区
// 切成 [当天零点, 次日零点)，避免浏览器时区把一次点击分到相邻日期。
func (s *service) dashboardTracking(ctx context.Context, selected time.Time) (dto.DashboardTracking, error) {
	dayStart := startOfDay(selected)
	out := dto.DashboardTracking{Date: dayStart.Format("2006-01-02")}
	rows, err := s.repository.ListTrackingDaily(ctx, bizLine, dayStart, dayStart.AddDate(0, 0, 1))
	if err != nil {
		return out, err
	}
	for _, row := range rows {
		switch row.EventKey {
		case dto.TrackingEventPortalOpen:
			out.PortalOpens = row.Count
		case dto.TrackingEventModelSquareClick:
			out.ModelSquareClicks = row.Count
		}
	}
	return out, nil
}
