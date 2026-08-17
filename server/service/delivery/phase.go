// 交付阶段（phase）：任务内部的工作流，以及仍被旧客户端读取的三阶段字段投影。

package delivery

import (
	"errors"
	"fmt"

	"service/delivery/internal/repository"
)

func normalizePhase(phase string) (string, error) {
	if phase == "" {
		return PhaseRequirement, nil
	}
	for _, known := range phaseOrder {
		if phase == known {
			return phase, nil
		}
	}
	return "", fmt.Errorf("未知的交付阶段：%s", phase)
}

func phaseForLegacyStatus(status string) string {
	switch status {
	case StatusDoing, StatusBlocked:
		return PhaseDevelopment
	case StatusDone:
		return PhaseTesting
	default:
		return PhaseRequirement
	}
}

func phaseForLegacyItem(item *repository.DeliveryItem) string {
	if item.Phase != "" {
		return item.Phase
	}
	requirement, development, _ := phaseStatusesOf(item)
	if requirement != StatusDone {
		return PhaseRequirement
	}
	if development != StatusDone {
		return PhaseDevelopment
	}
	return PhaseTesting
}

func normalizePhaseStatus(status string) (string, error) { return normalizeStatus(status) }

func phaseStatusesForCreate(requirement, development, testing, legacyStatus string) (string, string, string, error) {
	if requirement == "" && development == "" && testing == "" {
		req, dev, test := phaseStatusesForLegacyStatus(legacyStatus)
		return req, dev, test, nil
	}
	req, err := normalizePhaseStatus(requirement)
	if err != nil {
		return "", "", "", err
	}
	dev, err := normalizePhaseStatus(development)
	if err != nil {
		return "", "", "", err
	}
	test, err := normalizePhaseStatus(testing)
	if err != nil {
		return "", "", "", err
	}
	if err := validatePhaseSequence(req, dev, test); err != nil {
		return "", "", "", err
	}
	return req, dev, test, nil
}

func phaseStatusesForLegacyStatus(status string) (string, string, string) {
	switch status {
	case StatusDone:
		return StatusDone, StatusDone, StatusDone
	case StatusDoing:
		return StatusDone, StatusDoing, StatusTodo
	case StatusBlocked:
		return StatusDone, StatusBlocked, StatusTodo
	case StatusDropped:
		return StatusDropped, StatusDropped, StatusDropped
	default:
		return StatusTodo, StatusTodo, StatusTodo
	}
}

// phaseStatusesForCurrentTask 为仍读取旧三阶段字段的调用方提供连续状态快照。
// 任务的权威状态始终只有 Phase + Status；已完成的前序阶段保留 done，后续阶段
// 保留 todo，避免任何客户端将一条任务当成同时处于多个当前阶段。
func phaseStatusesForCurrentTask(phase, status string) (string, string, string) {
	switch phase {
	case PhaseDevelopment:
		return StatusDone, status, StatusTodo
	case PhaseTesting:
		return StatusDone, StatusDone, status
	default:
		return status, StatusTodo, StatusTodo
	}
}

func phaseStatusesOf(item *repository.DeliveryItem) (string, string, string) {
	if item.RequirementStatus == "" || item.DevelopmentStatus == "" || item.TestingStatus == "" {
		return phaseStatusesForLegacyStatus(item.Status)
	}
	return item.RequirementStatus, item.DevelopmentStatus, item.TestingStatus
}

func validatePhaseSequence(requirement, development, testing string) error {
	if requirement != StatusDone && (development != StatusTodo || testing != StatusTodo) {
		return errors.New("需求完成前不能开始开发或测试")
	}
	if development != StatusDone && testing != StatusTodo {
		return errors.New("开发完成前不能开始测试")
	}
	return nil
}

func aggregatePhaseStatus(requirement, development, testing string) string {
	if requirement == StatusDropped && development == StatusDropped && testing == StatusDropped {
		return StatusDropped
	}
	if requirement == StatusDropped || development == StatusDropped || testing == StatusDropped {
		return StatusDropped
	}
	if requirement == StatusBlocked || development == StatusBlocked || testing == StatusBlocked {
		return StatusBlocked
	}
	if testing == StatusDone {
		return StatusDone
	}
	if requirement == StatusDoing || development == StatusDoing || testing == StatusDoing || requirement == StatusDone || development == StatusDone {
		return StatusDoing
	}
	return StatusTodo
}

func phaseProgress(requirement, development, testing string) int {
	if aggregatePhaseStatus(requirement, development, testing) == StatusDropped {
		return 0
	}
	completed := 0
	for _, status := range []string{requirement, development, testing} {
		if status == StatusDone {
			completed++
		}
	}
	if completed == 3 {
		return 100
	}
	if testing == StatusDoing {
		return 85
	}
	if development == StatusDoing {
		return 50
	}
	if requirement == StatusDoing {
		return 15
	}
	return completed * 100 / 3
}

func phaseProgressForCurrentPhase(phase, status string) int {
	if status == StatusDone {
		switch phase {
		case PhaseRequirement:
			return 33
		case PhaseDevelopment:
			return 67
		default:
			return 100
		}
	}
	switch phase {
	case PhaseDevelopment:
		return 34
	case PhaseTesting:
		return 68
	default:
		return 0
	}
}

func phaseStatusOf(item *repository.DeliveryItem, phase string) string {
	requirement, development, testing := phaseStatusesOf(item)
	switch phase {
	case PhaseDevelopment:
		return development
	case PhaseTesting:
		return testing
	default:
		return requirement
	}
}

func countPhaseStatus(items []*repository.DeliveryItem, phase, status string) int {
	count := 0
	for _, item := range items {
		if phaseStatusOf(item, phase) == status {
			count++
		}
	}
	return count
}

func nextPhase(phase string) string {
	if phase == PhaseRequirement {
		return PhaseDevelopment
	}
	return PhaseTesting
}

func phaseColumn(phase string) string {
	switch phase {
	case PhaseDevelopment:
		return "development_status"
	case PhaseTesting:
		return "testing_status"
	default:
		return "requirement_status"
	}
}
