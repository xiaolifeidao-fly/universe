package delivery

import (
	"strings"
	"testing"
	"time"

	"service/delivery/internal/repository"
)

func items(specs ...[2]any) []*repository.DeliveryItem {
	rows := make([]*repository.DeliveryItem, 0, len(specs))
	for _, spec := range specs {
		rows = append(rows, &repository.DeliveryItem{
			Status:   spec[0].(string),
			Progress: spec[1].(int),
		})
	}
	return rows
}

// done 一律按 100 计，哪怕库里存的是 30 —— 这条规则原型写在前端，
// 服务端不兜住的话，一条被脚本改过状态的记录就能让汇报数字失真。
func TestAverageProgressForcesDoneTo100(t *testing.T) {
	got := averageProgress(items([2]any{StatusDone, 30}, [2]any{StatusTodo, 0}))
	if got != 50 {
		t.Fatalf("期望 50，实际 %v", got)
	}
}

// dropped 既不拉低也不抬高进度：不做的事不该出现在分母里。
func TestAverageProgressExcludesDropped(t *testing.T) {
	got := averageProgress(items(
		[2]any{StatusDone, 100},
		[2]any{StatusDropped, 0},
		[2]any{StatusDoing, 50},
	))
	if got != 75 {
		t.Fatalf("期望 75（(100+50)/2），实际 %v", got)
	}
	if count := countCounted(items([2]any{StatusDropped, 0}, [2]any{StatusTodo, 0})); count != 1 {
		t.Fatalf("countCounted 期望 1，实际 %d", count)
	}
}

func TestAverageProgressEmpty(t *testing.T) {
	if got := averageProgress(nil); got != 0 {
		t.Fatalf("空集期望 0，实际 %v", got)
	}
}

func TestBuildProgramOverviewUsesRequirementItemsAndModuleWeights(t *testing.T) {
	overview := buildProgramOverview(7, "测试项目", nil, []*repository.DeliveryModule{
		{ModuleKey: "core", Name: "核心", Weight: 80},
		{ModuleKey: "edge", Name: "边缘", Weight: 20},
	}, []*repository.DeliveryItem{
		{ModuleKey: "core", Status: StatusDone, Progress: 20},
		{ModuleKey: "core", Status: StatusDoing, Progress: 40},
		{ModuleKey: "edge", Status: StatusBlocked, Progress: 20},
		{ModuleKey: "edge", Status: StatusDropped, Progress: 90},
	})

	if overview.TotalCount != 4 || overview.StatusCounts[StatusDoing] != 1 || overview.StatusCounts[StatusDone] != 1 || overview.StatusCounts[StatusBlocked] != 1 {
		t.Fatalf("需求汇总的任务数或状态数不正确：%#v", overview)
	}
	if overview.PlainProgress != 53.33 || overview.MaturityScore != 60 {
		t.Fatalf("需求汇总进度口径不正确：plain=%v, maturity=%v", overview.PlainProgress, overview.MaturityScore)
	}
}

func TestOrderByCreationUsesAscendingOrderForEveryTask(t *testing.T) {
	first := time.Date(2026, time.August, 18, 9, 0, 0, 0, time.UTC)
	second := first.Add(time.Minute)
	items := []*repository.DeliveryItem{
		{Id: 4, ItemKey: "done-late", Status: StatusDone, CreatedTime: second},
		{Id: 3, ItemKey: "doing-early", Status: StatusDoing, CreatedTime: first},
		{Id: 2, ItemKey: "todo-early-low-id", Status: StatusTodo, CreatedTime: first},
		{Id: 5, ItemKey: "done-early", Status: StatusDone, CreatedTime: first},
	}

	ordered := orderByCreation(items)
	got := []string{ordered[0].ItemKey, ordered[1].ItemKey, ordered[2].ItemKey, ordered[3].ItemKey}
	want := []string{"todo-early-low-id", "doing-early", "done-early", "done-late"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("看板任务未按创建时间正序排列：got=%v want=%v", got, want)
	}
	if items[0].ItemKey != "done-late" {
		t.Fatalf("排序不应修改调用方传入的任务切片：%v", items)
	}
}

func TestItemViewIncludesCreatedAt(t *testing.T) {
	created := time.Date(2026, time.August, 21, 10, 30, 0, 0, time.UTC)
	view := toItemView(&repository.DeliveryItem{CreatedTime: created}, nil, nil, nil)
	if view.CreatedAt == nil || !view.CreatedAt.Equal(created) {
		t.Fatalf("任务视图未返回创建时间：%#v", view.CreatedAt)
	}
}

func TestNormalizeProgress(t *testing.T) {
	cases := []struct {
		status string
		input  int
		want   int
	}{
		{StatusDone, 0, 100},
		{StatusDoing, 150, 100},
		{StatusDoing, -5, 0},
		{StatusTodo, 40, 40},
	}
	for _, c := range cases {
		if got := normalizeProgress(c.status, c.input); got != c.want {
			t.Fatalf("normalizeProgress(%s,%d) 期望 %d，实际 %d", c.status, c.input, c.want, got)
		}
	}
}

func TestItemListRecentFirstAcceptsOnlyKnownSorts(t *testing.T) {
	if recent, err := itemListRecentFirst("recent"); err != nil || !recent {
		t.Fatalf("recent 应按创建时间倒序：%v, %v", recent, err)
	}
	if recent, err := itemListRecentFirst(""); err != nil || recent {
		t.Fatalf("空排序应保留看板手工顺序：%v, %v", recent, err)
	}
	if _, err := itemListRecentFirst("created_time desc"); err == nil {
		t.Fatal("未声明排序不得传入 repository")
	}
}

func TestNormalizeStatusRejectsUnknown(t *testing.T) {
	if _, err := normalizeStatus("finished"); err == nil {
		t.Fatal("未知状态应当报错")
	}
	if status, err := normalizeStatus(""); err != nil || status != StatusTodo {
		t.Fatalf("空状态应缺省为 todo，实际 %s %v", status, err)
	}
}

func TestRequirementChangeEventsOnlyRecordActualChanges(t *testing.T) {
	start := time.Date(2026, time.August, 17, 9, 0, 0, 0, time.Local)
	current := &repository.DeliveryRequirement{
		BizLine: "xianglong", ProgramID: 7, RequirementKey: "req-1", Name: "原名称",
		Detail: "原始范围", PlannedStartAt: &start, PlannedEndAt: &start,
		Status: RequirementStatusOpen, Mode: RequirementModeProfessional, StartPhase: PhaseRequirement,
		SplitTasks: true, StageKey: "s1", ModuleKey: "module-a", Kind: KindCapability, OwnerNames: "甲", AssistantNames: "乙",
	}
	events := requirementChangeEvents(current, "新名称", "原始范围", &start, &start,
		RequirementStatusOpen, RequirementModeProfessional, PhaseRequirement, true, false, false,
		"s1", "module-a", KindCapability, "甲", "乙", "u-1", "张三")
	if len(events) != 1 {
		t.Fatalf("仅名称变化应记录一条事件，实际 %d", len(events))
	}
	event := events[0]
	if event.Field != "name" || event.FromValue != "原名称" || event.ToValue != "新名称" || event.RequirementKey != "req-1" {
		t.Fatalf("需求字段变更记录不正确：%#v", event)
	}
}

func TestRequirementTimelineValueDoesNotCopyLongDocuments(t *testing.T) {
	if got := requirementTimelineValue(strings.Repeat("a", 121)); got != "已更新" {
		t.Fatalf("长文本应在时间线中脱敏为已更新，实际 %q", got)
	}
}

func TestPhaseStatusesForLegacyStatus(t *testing.T) {
	cases := []struct {
		status string
		want   [3]string
	}{
		{StatusTodo, [3]string{StatusTodo, StatusTodo, StatusTodo}},
		{StatusDoing, [3]string{StatusDone, StatusDoing, StatusTodo}},
		{StatusDone, [3]string{StatusDone, StatusDone, StatusDone}},
	}
	for _, c := range cases {
		req, dev, test := phaseStatusesForLegacyStatus(c.status)
		if got := [3]string{req, dev, test}; got != c.want {
			t.Fatalf("legacy %s = %#v, want %#v", c.status, got, c.want)
		}
	}
}

func TestPhaseStatusesForCurrentTaskExposeOneCurrentPhase(t *testing.T) {
	cases := []struct {
		phase  string
		status string
		want   [3]string
	}{
		{PhaseRequirement, StatusDoing, [3]string{StatusDoing, StatusTodo, StatusTodo}},
		{PhaseRequirement, StatusDone, [3]string{StatusDone, StatusTodo, StatusTodo}},
		{PhaseDevelopment, StatusDoing, [3]string{StatusDone, StatusDoing, StatusTodo}},
		{PhaseDevelopment, StatusBlocked, [3]string{StatusDone, StatusBlocked, StatusTodo}},
		{PhaseTesting, StatusDoing, [3]string{StatusDone, StatusDone, StatusDoing}},
		{PhaseTesting, StatusDone, [3]string{StatusDone, StatusDone, StatusDone}},
	}
	for _, c := range cases {
		req, dev, test := phaseStatusesForCurrentTask(c.phase, c.status)
		if got := [3]string{req, dev, test}; got != c.want {
			t.Fatalf("current %s/%s = %#v, want %#v", c.phase, c.status, got, c.want)
		}
	}
}

func TestPhaseSequenceAndAggregateStatus(t *testing.T) {
	if err := validatePhaseSequence(StatusDoing, StatusTodo, StatusTodo); err != nil {
		t.Fatalf("需求进行中应合法：%v", err)
	}
	if err := validatePhaseSequence(StatusTodo, StatusDoing, StatusTodo); err == nil {
		t.Fatal("需求未完成时开发开始应被拒绝")
	}
	if err := validatePhaseSequence(StatusDone, StatusDoing, StatusDoing); err == nil {
		t.Fatal("开发未完成时测试开始应被拒绝")
	}
	if got := aggregatePhaseStatus(StatusDone, StatusDone, StatusDoing); got != StatusDoing {
		t.Fatalf("汇总状态 = %s, want %s", got, StatusDoing)
	}
	if got := aggregatePhaseStatus(StatusDone, StatusDone, StatusDone); got != StatusDone {
		t.Fatalf("汇总状态 = %s, want %s", got, StatusDone)
	}
}

func TestRequirementDocumentPathIsAlwaysTaskScoped(t *testing.T) {
	if got := requirementDocumentPath("../../outside.md", "billing", "task-42"); got != "doc/billing/task-42/文档.md" {
		t.Fatalf("需求文档路径必须由模块和任务键决定，实际 %q", got)
	}
}

func TestStoredRequirementDocumentPathSurvivesModuleMove(t *testing.T) {
	path := "doc/data/screen/task-42/文档.md"
	if got := storedRequirementDocumentPath(path, "billing", "task-42"); got != path {
		t.Fatalf("模块迁移后需求文档路径应保持不变，实际 %q", got)
	}
	if got := storedRequirementDocumentPath("doc/../../task-42/文档.md", "billing", "task-42"); got != "doc/billing/task-42/文档.md" {
		t.Fatalf("非法路径必须回退到任务路径，实际 %q", got)
	}
}

func TestRequirementViewIncludesPlanningContext(t *testing.T) {
	startAt := time.Date(2026, time.August, 17, 9, 0, 0, 0, time.UTC)
	endAt := time.Date(2026, time.August, 18, 18, 0, 0, 0, time.UTC)
	view := toRequirementView(&repository.DeliveryRequirement{
		StageKey:          "s2",
		ModuleKey:         "billing",
		Kind:              KindCapability,
		GeneratePrototype: true,
		PlannedStartAt:    &startAt,
		PlannedEndAt:      &endAt,
	})
	if view.StageKey != "s2" || view.ModuleKey != "billing" || view.Kind != KindCapability || !view.GeneratePrototype || view.PlannedStartAt == nil || view.PlannedEndAt == nil {
		t.Fatalf("需求拆解上下文未完整回显：%#v", view)
	}
}

func TestNormalizeRequirementReferencesKeepsValidUniqueKeys(t *testing.T) {
	stored, err := normalizeRequirementReferences([]string{" req-a ", "req-a", "req-b", "", "req-self"}, "req-self")
	if err != nil || stored != ",req-a,req-b," {
		t.Fatalf("引用需求键未按 ,key, 形式归一：%q, %v", stored, err)
	}
	if _, err := normalizeRequirementReferences([]string{"../etc"}, ""); err == nil {
		t.Fatal("非法需求键必须拒绝保存")
	}
	if stored, err := normalizeRequirementReferences(nil, ""); err != nil || stored != "" {
		t.Fatalf("空引用应存成空串：%q, %v", stored, err)
	}
}

func TestRequirementViewReadsBackReferencedRequirements(t *testing.T) {
	view := toRequirementView(&repository.DeliveryRequirement{
		ReferenceRequirementKeys: ",req-a,req-b,",
		ReferenceItemKeys:        ",task-a,task.v1,",
	})
	if len(view.ReferenceRequirementKeys) != 2 || view.ReferenceRequirementKeys[0] != "req-a" {
		t.Fatalf("引用需求未完整回显：%#v", view.ReferenceRequirementKeys)
	}
	if len(view.ReferenceItemKeys) != 2 || view.ReferenceItemKeys[1] != "task.v1" {
		t.Fatalf("引用任务未完整回显：%#v", view.ReferenceItemKeys)
	}
	empty := toRequirementView(&repository.DeliveryRequirement{})
	if empty.ReferenceRequirementKeys == nil || len(empty.ReferenceRequirementKeys) != 0 {
		t.Fatalf("没有引用时应回显空数组而不是 null：%#v", empty.ReferenceRequirementKeys)
	}
	if empty.ReferenceItemKeys == nil || len(empty.ReferenceItemKeys) != 0 {
		t.Fatalf("没有任务关联时应回显空数组而不是 null：%#v", empty.ReferenceItemKeys)
	}
}

func TestNormalizeRequirementItemReferencesKeepsValidUniqueKeys(t *testing.T) {
	stored, err := normalizeRequirementItemReferences([]string{" task-a ", "task-a", "task.v1", ""})
	if err != nil || stored != ",task-a,task.v1," {
		t.Fatalf("引用任务键未按 ,key, 形式归一：%q, %v", stored, err)
	}
	if _, err := normalizeRequirementItemReferences([]string{"../etc"}); err == nil {
		t.Fatal("非法任务键必须拒绝保存")
	}
	if stored, err := normalizeRequirementItemReferences(nil); err != nil || stored != "" {
		t.Fatalf("空任务关联应存成空串：%q, %v", stored, err)
	}
}

func TestNormalizeRequirementPlannedPeriod(t *testing.T) {
	startAt := time.Date(2026, time.August, 17, 9, 0, 0, 0, time.UTC)
	endAt := time.Date(2026, time.August, 18, 18, 0, 0, 0, time.UTC)
	if _, _, err := normalizeRequirementPlannedPeriod(&startAt, nil); err == nil {
		t.Fatal("只有一端时间时应拒绝保存")
	}
	if _, _, err := normalizeRequirementPlannedPeriod(&endAt, &startAt); err == nil {
		t.Fatal("结束早于开始时应拒绝保存")
	}
	actualStart, actualEnd, err := normalizeRequirementPlannedPeriod(&startAt, &endAt)
	if err != nil || !actualStart.Equal(startAt) || !actualEnd.Equal(endAt) {
		t.Fatalf("合法排期不应被改变：%v, %v, %v", actualStart, actualEnd, err)
	}
}

func TestRequirementPrototypePathIsFixedToRequirementDocumentDirectory(t *testing.T) {
	path, err := requirementPrototypePath("req-20260815-01")
	if err != nil || path != "doc/requirements/req-20260815-01/prototype" {
		t.Fatalf("需求原型路径不正确：%q, %v", path, err)
	}
	if _, err := requirementPrototypePath("../outside"); err == nil {
		t.Fatal("需求原型路径必须拒绝越界需求键")
	}
}

func TestPhaseProgressReflectsOnlyTheCurrentPhase(t *testing.T) {
	cases := []struct {
		phase  string
		status string
		want   int
	}{
		{PhaseRequirement, StatusTodo, 0},
		{PhaseRequirement, StatusDone, 33},
		{PhaseDevelopment, StatusTodo, 34},
		{PhaseDevelopment, StatusDone, 67},
		{PhaseTesting, StatusTodo, 68},
		{PhaseTesting, StatusDone, 100},
	}
	for _, c := range cases {
		if got := phaseProgressForCurrentPhase(c.phase, c.status); got != c.want {
			t.Fatalf("phaseProgressForCurrentPhase(%s,%s) = %d, want %d", c.phase, c.status, got, c.want)
		}
	}
}

func TestNormalizeExecutorType(t *testing.T) {
	if got, err := normalizeExecutorType(" Claude-Code "); err != nil || got != "claude-code" {
		t.Fatalf("normalizeExecutorType = %q, %v", got, err)
	}
	for _, value := range []string{"", "Claude Code", "a/b"} {
		if _, err := normalizeExecutorType(value); err == nil {
			t.Fatalf("normalizeExecutorType(%q) should fail", value)
		}
	}
}

func TestNormalizeExecutionSessionStatus(t *testing.T) {
	if got, err := normalizeExecutionSessionStatus("", "pending"); err != nil || got != "pending" {
		t.Fatalf("default status = %q, %v", got, err)
	}
	if _, err := normalizeExecutionSessionStatus("doing", ""); err == nil {
		t.Fatal("task status must not be accepted as execution session status")
	}
}

func TestExecutionMetadata(t *testing.T) {
	raw, err := normalizeRawExecutionMetadata([]byte(`{"branch":"feature/test"}`))
	if err != nil || raw != `{"branch":"feature/test"}` {
		t.Fatalf("metadata = %q, %v", raw, err)
	}
	if _, err := normalizeRawExecutionMetadata([]byte(`[]`)); err == nil {
		t.Fatal("array metadata should fail")
	}
}

// 原型的 pit/cap/have 要能原样导入。
func TestNormalizeKindAcceptsPrototypeAliases(t *testing.T) {
	cases := map[string]string{
		"pit": KindGap, "cap": KindCapability, "have": KindAsset,
		"gap": KindGap, "capability": KindCapability, "asset": KindAsset,
	}
	for input, want := range cases {
		if got := normalizeKind(input); got != want {
			t.Fatalf("normalizeKind(%s) 期望 %s，实际 %s", input, want, got)
		}
	}
	if got := normalizeKind(""); got != "" {
		t.Fatalf("空类型应保持空（表示不过滤），实际 %s", got)
	}
	if got := normalizeKindOrDefault("", KindGap); got != KindGap {
		t.Fatalf("空类型落库应取缺省，实际 %s", got)
	}
}

func TestStageKeyOf(t *testing.T) {
	if got := stageKeyOf(3); got != "s3" {
		t.Fatalf("期望 s3，实际 %s", got)
	}
}

func TestParseDate(t *testing.T) {
	if got, err := parseDate(""); err != nil || got != nil {
		t.Fatalf("空日期应返回 nil，实际 %v %v", got, err)
	}
	got, err := parseDate("2026-08-11")
	if err != nil || formatDate(got) != "2026-08-11" {
		t.Fatalf("日期解析失败：%v %v", got, err)
	}
	if _, err := parseDate("2026/08/11"); err == nil {
		t.Fatal("错误格式应当报错")
	}
}

func TestBenefitTagsAreNormalizedAndStoredAsJSON(t *testing.T) {
	raw, tags, err := marshalBenefitTags([]string{" 提升转化 ", "降低人工", "提升转化", ""})
	if err != nil {
		t.Fatalf("收益标签应可写入：%v", err)
	}
	if raw != `["提升转化","降低人工"]` {
		t.Fatalf("收益标签 JSON = %q", raw)
	}
	if want := []string{"提升转化", "降低人工"}; !sameStrings(tags, want) {
		t.Fatalf("归一化标签 = %#v, want %#v", tags, want)
	}
	if got := storedBenefitTags(raw); !sameStrings(got, tags) {
		t.Fatalf("存储标签回显 = %#v, want %#v", got, tags)
	}
}

func TestBenefitTagsRejectEmptyAndOversizedValues(t *testing.T) {
	if _, err := normalizeBenefitTags(nil); err == nil {
		t.Fatal("新任务缺少收益标签必须拒绝")
	}
	if _, err := normalizeBenefitTags([]string{"一", "二", "三", "四", "五", "六", "七"}); err == nil {
		t.Fatal("超过六个收益标签必须拒绝")
	}
	if _, err := normalizeBenefitTags([]string{strings.Repeat("收益", 17)}); err == nil {
		t.Fatal("过长收益标签必须拒绝")
	}
}

func TestValidateDependencyChangeAllowsParallelBranchesAndJoin(t *testing.T) {
	rows := []*repository.DeliveryItem{{ItemKey: "a"}, {ItemKey: "b"}, {ItemKey: "c"}, {ItemKey: "d"}}
	edges := []*repository.DeliveryItemDependency{
		{PredecessorItemKey: "a", SuccessorItemKey: "b"},
		{PredecessorItemKey: "a", SuccessorItemKey: "c"},
		{PredecessorItemKey: "b", SuccessorItemKey: "d"},
	}
	if err := validateDependencyChange(rows, edges, "d", []string{"b", "c"}); err != nil {
		t.Fatalf("A -> (B,C) -> D 应当合法：%v", err)
	}
}

func TestValidateDependencyChangeRejectsCycle(t *testing.T) {
	rows := []*repository.DeliveryItem{{ItemKey: "a"}, {ItemKey: "b"}, {ItemKey: "c"}, {ItemKey: "d"}}
	edges := []*repository.DeliveryItemDependency{
		{PredecessorItemKey: "a", SuccessorItemKey: "b"},
		{PredecessorItemKey: "a", SuccessorItemKey: "c"},
		{PredecessorItemKey: "b", SuccessorItemKey: "d"},
		{PredecessorItemKey: "c", SuccessorItemKey: "d"},
	}
	if err := validateDependencyChange(rows, edges, "a", []string{"d"}); err == nil {
		t.Fatal("D -> A 会与 A -> (B,C) -> D 形成环，应当拒绝")
	}
}

func TestValidateDependencyChangeRejectsSelfAndUnknownItem(t *testing.T) {
	rows := []*repository.DeliveryItem{{ItemKey: "a"}, {ItemKey: "b"}}
	if err := validateDependencyChange(rows, nil, "b", []string{"b"}); err == nil {
		t.Fatal("任务不能依赖自己")
	}
	if err := validateDependencyChange(rows, nil, "b", []string{"missing"}); err == nil {
		t.Fatal("前置任务必须属于当前项目")
	}
}

func TestNormalizeDependencyTargetSides(t *testing.T) {
	got := normalizeDependencyTargetSides(map[string]string{
		"a": "top",
		"b": "right",
		"c": "invalid",
		"x": "bottom",
	}, []string{"a", "b", "c", "d"})
	want := map[string]string{"a": "top", "b": "right", "c": "", "d": ""}
	if !sameStringMap(got, want) {
		t.Fatalf("normalizeDependencyTargetSides() = %#v, want %#v", got, want)
	}
}

func TestNormalizeDependencySourceSides(t *testing.T) {
	got := normalizeDependencySides(map[string]string{
		"a": "left",
		"b": "bottom",
		"c": "invalid",
		"x": "top",
	}, []string{"a", "b", "c", "d"})
	want := map[string]string{"a": "left", "b": "bottom", "c": "", "d": ""}
	if !sameStringMap(got, want) {
		t.Fatalf("normalizeDependencySides() = %#v, want %#v", got, want)
	}
}

func TestNormalizePlanningSessionStatusDefaultsToRunning(t *testing.T) {
	got, err := normalizePlanningSessionStatus("")
	if err != nil || got != "running" {
		t.Fatalf("空状态应回落到 running，实际 %q err=%v", got, err)
	}
	if _, err := normalizePlanningSessionStatus("Interrupted"); err != nil {
		t.Fatalf("中断是拆解会话的正常收尾状态：%v", err)
	}
	// 任务执行会话那套词表不通用，别把 blocked 混进来。
	if _, err := normalizePlanningSessionStatus("blocked"); err == nil {
		t.Fatal("未知的拆解会话状态必须报错")
	}
}

func TestPlanningSessionViewCarriesThreadDirectory(t *testing.T) {
	view := toPlanningSessionView(&repository.DeliveryRequirementPlanningSession{
		ProgramID: 7, RequirementKey: "req-1", ExecutorType: "codex", ThreadID: "th-1",
		Title: "需求拆解", Status: "completed", MetadataJSON: `{"stageKey":"s2"}`, Version: 3,
	})
	if view.ThreadID != "th-1" || view.Title != "需求拆解" || view.Status != "completed" {
		t.Fatalf("会话目录未完整回显：%#v", view)
	}
	if view.Metadata["stageKey"] != "s2" {
		t.Fatalf("拆解上下文未解析：%#v", view.Metadata)
	}
}

func TestMarshalPlanningMetadataRejectsOversizedContext(t *testing.T) {
	oversized := make([]string, 0, 40000)
	for index := 0; index < 40000; index++ {
		oversized = append(oversized, "task-0000000000")
	}
	if _, err := marshalPlanningMetadata(map[string]any{"baseline": map[string]any{"items": oversized}}); err == nil {
		t.Fatal("超过 256KB 的拆解上下文必须被挡住")
	}
	if _, err := marshalPlanningMetadata(nil); err != nil {
		t.Fatalf("空 metadata 应写成 {}：%v", err)
	}
}
