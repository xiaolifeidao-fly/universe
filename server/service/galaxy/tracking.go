package galaxy

import (
	"context"
	"errors"
	"strings"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

const dashboardTrackingDays = 14

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

// dashboardTracking 返回含空日期的连续日序列。没有事件的日子必须明确是 0，
// 否则管理端的表会把 9 月 20 日直接接到 9 月 22 日，看起来像趋势没有断过。
func (s *service) dashboardTracking(ctx context.Context, today time.Time) (dto.DashboardTracking, error) {
	from := today.AddDate(0, 0, -(dashboardTrackingDays - 1))
	to := today.AddDate(0, 0, 1)
	out := dto.DashboardTracking{
		From: from.Format("2006-01-02"), To: today.Format("2006-01-02"),
		Days: make([]dto.DashboardTrackingDay, dashboardTrackingDays),
	}
	byDate := make(map[string]*dto.DashboardTrackingDay, dashboardTrackingDays)
	for index := 0; index < dashboardTrackingDays; index++ {
		date := from.AddDate(0, 0, index).Format("2006-01-02")
		out.Days[index] = dto.DashboardTrackingDay{Date: date}
		byDate[date] = &out.Days[index]
	}

	rows, err := s.repository.ListTrackingDaily(ctx, bizLine, from, to)
	if err != nil {
		return out, err
	}
	for _, row := range rows {
		day := byDate[row.EventDate.Format("2006-01-02")]
		if day == nil {
			continue
		}
		switch row.EventKey {
		case dto.TrackingEventPortalOpen:
			day.PortalOpens = row.Count
		case dto.TrackingEventModelSquareClick:
			day.ModelSquareClicks = row.Count
		}
	}
	return out, nil
}
