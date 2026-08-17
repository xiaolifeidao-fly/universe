// 任务状态、进度与类型的归一化。

package delivery

import (
	"fmt"

	"service/delivery/internal/repository"
)

func progressOf(item *repository.DeliveryItem) int {
	if item.Status == StatusDone {
		return 100
	}
	if item.Progress < 0 {
		return 0
	}
	if item.Progress > 100 {
		return 100
	}
	return item.Progress
}

func normalizeStatus(status string) (string, error) {
	if status == "" {
		return StatusTodo, nil
	}
	for _, known := range statusOrder {
		if known == status {
			return status, nil
		}
	}
	return "", fmt.Errorf("未知的任务状态：%s", status)
}

func normalizeProgress(status string, progress int) int {
	if status == StatusDone {
		return 100
	}
	if progress < 0 {
		return 0
	}
	if progress > 100 {
		return 100
	}
	return progress
}

func normalizeKind(kind string) string {
	if kind == "" {
		return ""
	}
	if mapped, ok := kindAlias[kind]; ok {
		return mapped
	}
	return kind
}

func normalizeKindOrDefault(kind, fallback string) string {
	if mapped := normalizeKind(kind); mapped != "" {
		return mapped
	}
	return fallback
}
