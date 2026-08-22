// 交付域的固定词表：状态、阶段、任务类型与各处共用的上限。
// 半年内不会变的枚举写死在代码里，不做成配置表。

package delivery

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// 任务状态。看板的五列，半年内不会变，先写死在代码里 ——
// 早早做成配置表只是给自己加一层查询。
const (
	StatusTodo    = "todo"
	StatusDoing   = "doing"
	StatusDone    = "done"
	StatusBlocked = "blocked"
	StatusDropped = "dropped"
)

// 交付阶段是任务内部的工作流；不要和项目的 StageKey（路线图阶段）混为一谈。
const (
	PhaseRequirement = "requirement"
	PhaseDevelopment = "development"
	PhaseTesting     = "testing"
)

// 任务类型。原型里叫 pit/cap/have，落库统一成语义化的写法，导入时做映射。
const (
	KindGap        = "gap"        // 坑点：现在挡着路的问题
	KindCapability = "capability" // 能力：要建出来的东西
	KindAsset      = "asset"      // 已具备：不用重做的存量
)

const dateLayout = "2006-01-02"

const (
	maxExecutionMetadataBytes = 8192
	// 拆解上下文要带上整份基线键集合与本轮产出，8KB 不够用，单独放宽。
	maxPlanningMetadataBytes = 256 * 1024
	// MEDIUMTEXT 最多约 16MB；留出请求体与编码余量，单份文档限制为 8MB。
	maxItemDocumentBytes = 8 * 1024 * 1024
	// 收益标签在看板上需要一眼读完，限制数量和单项长度，避免被任务说明替代。
	maxBenefitTagCount = 6
	maxBenefitTagRunes = 32
)

var statusOrder = []string{StatusTodo, StatusDoing, StatusDone, StatusBlocked, StatusDropped}

var phaseOrder = []string{PhaseRequirement, PhaseDevelopment, PhaseTesting}

var statusNames = map[string]string{
	StatusTodo:    "未开始",
	StatusDoing:   "进行中",
	StatusDone:    "已完成",
	StatusBlocked: "受阻",
	StatusDropped: "不做",
}

var kindAlias = map[string]string{
	"pit": KindGap, "gap": KindGap,
	"cap": KindCapability, "capability": KindCapability,
	"have": KindAsset, "asset": KindAsset,
}

var executorTypePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

var executionSessionStatuses = map[string]struct{}{
	"pending": {}, "running": {}, "completed": {}, "blocked": {}, "closed": {},
}

const (
	ExecutionBatchModeParallel    = "parallel"
	ExecutionBatchModeSequence    = "sequence"
	ExecutionBatchStatusRunning   = "running"
	ExecutionBatchStatusCompleted = "completed"
	ExecutionBatchStatusBlocked   = "blocked"
	ExecutionBatchItemPending     = "pending"
	ExecutionBatchItemRunning     = "running"
	ExecutionBatchItemCompleted   = "completed"
	ExecutionBatchItemBlocked     = "blocked"
)

var executionBatchModes = map[string]struct{}{
	ExecutionBatchModeParallel: {}, ExecutionBatchModeSequence: {},
}

var executionBatchStatuses = map[string]struct{}{
	ExecutionBatchStatusRunning: {}, ExecutionBatchStatusCompleted: {}, ExecutionBatchStatusBlocked: {},
}

var executionBatchItemStatuses = map[string]struct{}{
	ExecutionBatchItemPending: {}, ExecutionBatchItemRunning: {}, ExecutionBatchItemCompleted: {}, ExecutionBatchItemBlocked: {},
}

func normalizeExecutionBatchMode(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if _, ok := executionBatchModes[value]; !ok {
		return "", fmt.Errorf("未知的执行批次模式：%s", value)
	}
	return value, nil
}

func normalizeExecutionBatchStatus(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if _, ok := executionBatchStatuses[value]; !ok {
		return "", fmt.Errorf("未知的执行批次状态：%s", value)
	}
	return value, nil
}

func normalizeExecutionBatchItemStatus(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if _, ok := executionBatchItemStatuses[value]; !ok {
		return "", fmt.Errorf("未知的批次任务状态：%s", value)
	}
	return value, nil
}

func generateExecutionBatchID() string {
	raw := make([]byte, 10)
	if _, err := rand.Read(raw); err != nil {
		// crypto/rand 失败极罕见；保留时间戳仍能让批次具备可读、可索引的唯一键。
		return fmt.Sprintf("batch-%d", time.Now().UnixNano())
	}
	return "batch-" + hex.EncodeToString(raw)
}

// 拆解会话的状态跟着执行器的回合状态走，和任务执行会话不是同一套词表。
var planningSessionStatuses = map[string]struct{}{
	"running": {}, "completed": {}, "failed": {}, "interrupted": {},
}
