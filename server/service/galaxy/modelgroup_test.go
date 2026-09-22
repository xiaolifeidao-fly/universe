package galaxy

import (
	"context"
	"database/sql/driver"
	"errors"
	"testing"

	"contract"
	"service/galaxy/dto"
)

// 一次请求落在哪个分组上。
//
// 这一步决定三件事：按哪份价收、允许想多深、算不算快速。解错了不会报错 ——
// 只是这一笔按另一个分组的价结算，而使用者与共享者两头一起错、方向还一致，
// 对账也发现不了。所以每一条分支都钉死。

// groupTable 造一批分组行。is_default 用 1 / nil 表示，和库里那一列的口径一致
// （唯一索引靠 NULL 不参与唯一性来保证「每个模型最多一个默认分组」）。
func groupTable(rows ...[]driver.Value) map[string]scriptedTable {
	return map[string]scriptedTable{
		"zt_galaxy_model_group": {
			columns: []string{"group_id", "model_id", "name", "efforts_json", "allow_fast", "listed", "is_default"},
			rows:    rows,
		},
	}
}

// 密钥选了分组：按**这次请求的模型**在选中的那几个里找。
func TestResolveGroupPolicyPicksTheKeysGroupForThisModel(t *testing.T) {
	svc, _, _ := banHarness(t, groupTable(
		[]driver.Value{"mg_OPUS_STD", "claude-opus-5", "标准", `["medium","high"]`, false, true, nil},
		[]driver.Value{"mg_OPUS_DEEP", "claude-opus-5", "深度", `["max"]`, true, true, nil},
		[]driver.Value{"mg_HAIKU_STD", "claude-haiku-4-5", "标准", `[]`, false, true, 1},
	))
	caller := dto.Caller{KeyID: "ck_1", Groups: []string{"mg_OPUS_DEEP", "mg_HAIKU_STD"}}

	policy, err := svc.ResolveGroupPolicy(context.Background(), caller,
		contract.RouteKey{Model: "claude-opus-5", Family: contract.FamilyAnthropic})
	if err != nil {
		t.Fatalf("该解得出来：%v", err)
	}
	if policy.GroupID != "mg_OPUS_DEEP" || !policy.AllowFast {
		t.Fatalf("该落在深度那一组且允许快速，实际 %+v", policy)
	}
	// 同一把密钥换个模型，落到它为那个模型选的分组上。
	policy, err = svc.ResolveGroupPolicy(context.Background(), caller,
		contract.RouteKey{Model: "claude-haiku-4-5", Family: contract.FamilyAnthropic})
	if err != nil {
		t.Fatalf("该解得出来：%v", err)
	}
	if policy.GroupID != "mg_HAIKU_STD" || policy.AllowFast {
		t.Fatalf("该落在 haiku 的标准组且不允许快速，实际 %+v", policy)
	}
}

// 密钥没买这个模型的分组 → **明确拒绝**，不回落。
//
// 悄悄按默认分组跑，等于把一个人没付钱的档次送给他，而账单上看不出任何异常。
func TestResolveGroupPolicyRejectsModelWithoutPickedGroup(t *testing.T) {
	svc, _, _ := banHarness(t, groupTable(
		[]driver.Value{"mg_OPUS_STD", "claude-opus-5", "标准", `[]`, false, true, 1},
		[]driver.Value{"mg_HAIKU_STD", "claude-haiku-4-5", "标准", `[]`, false, true, 1},
	))
	_, err := svc.ResolveGroupPolicy(context.Background(),
		dto.Caller{KeyID: "ck_1", Groups: []string{"mg_OPUS_STD"}},
		contract.RouteKey{Model: "claude-haiku-4-5", Family: contract.FamilyAnthropic})
	if err == nil {
		t.Fatal("密钥没选这个模型的分组，应当拒绝而不是回落到默认组")
	}
	var unitError *contract.UnitError
	if !errors.As(err, &unitError) || unitError.Code != contract.CodeModelNotAllowed {
		t.Fatalf("要回 model_not_allowed，实际 %v", err)
	}
}

// 老密钥（没选分组）落到这个模型的**默认分组**上 —— 迁移期的退路。
func TestResolveGroupPolicyFallsBackToDefaultGroup(t *testing.T) {
	svc, _, _ := banHarness(t, groupTable(
		[]driver.Value{"mg_OPUS_DEEP", "claude-opus-5", "深度", `["max"]`, true, true, nil},
		[]driver.Value{"mg_OPUS_STD", "claude-opus-5", "标准", `["medium"]`, false, true, 1},
	))
	policy, err := svc.ResolveGroupPolicy(context.Background(), dto.Caller{KeyID: "ck_old"},
		contract.RouteKey{Model: "claude-opus-5", Family: contract.FamilyAnthropic})
	if err != nil {
		t.Fatalf("老密钥该照旧能用：%v", err)
	}
	if policy.GroupID != "mg_OPUS_STD" {
		t.Fatalf("该落在默认分组上，实际 %q", policy.GroupID)
	}
}

// 这个模型压根没建分组：不约束，行为和加分组之前完全一样。
//
// 这一条是迁移那一刻的安全网：库里一行分组都没有时，全站请求都走这条路。
func TestResolveGroupPolicyUnconstrainedWithoutGroups(t *testing.T) {
	svc, _, _ := banHarness(t, groupTable())
	policy, err := svc.ResolveGroupPolicy(context.Background(), dto.Caller{KeyID: "ck_old"},
		contract.RouteKey{Model: "claude-opus-5", Family: contract.FamilyAnthropic})
	if err != nil {
		t.Fatalf("没有分组时不该报错：%v", err)
	}
	if policy.GroupID != "" {
		t.Fatalf("不该凭空造一个分组出来，实际 %q", policy.GroupID)
	}
	// **快速要放行**：零值 GroupPolicy 的 AllowFast 是 false，拿零值当「不限」
	// 会把每一个没落到分组上的请求都从快速降级回普通。
	if !policy.AllowFast {
		t.Fatal("没有分组约束时，快速该原样透传")
	}
}

// 没有模型的请求（count_tokens 之类）不约束：没有模型就谈不上分组。
func TestResolveGroupPolicyWithoutModel(t *testing.T) {
	svc, _, _ := banHarness(t, groupTable(
		[]driver.Value{"mg_OPUS_STD", "claude-opus-5", "标准", `[]`, false, true, 1},
	))
	policy, err := svc.ResolveGroupPolicy(context.Background(), dto.Caller{KeyID: "ck_1", Groups: []string{"mg_OPUS_STD"}},
		contract.RouteKey{Family: contract.FamilyAnthropic})
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if policy.GroupID != "" || !policy.AllowFast {
		t.Fatalf("该是不约束，实际 %+v", policy)
	}
}

// 签发密钥时：同一个模型只能选一个分组。
//
// 选两个的话，一次请求就回答不了「按哪份价收」—— 随便挑一个的后果是
// 同一把密钥今天按标准价、明天按深度价收钱。
func TestValidateKeyGroupsRejectsTwoGroupsOfOneModel(t *testing.T) {
	svc, _, _ := banHarness(t, groupTable(
		[]driver.Value{"mg_OPUS_STD", "claude-opus-5", "标准", `[]`, false, true, 1},
		[]driver.Value{"mg_OPUS_DEEP", "claude-opus-5", "深度", `["max"]`, true, true, nil},
	))
	if _, err := svc.validateKeyGroups(context.Background(), []string{"mg_OPUS_STD", "mg_OPUS_DEEP"}); err == nil {
		t.Fatal("同一个模型选了两个分组，应当被拒")
	}
	if _, err := svc.validateKeyGroups(context.Background(), []string{"mg_OPUS_DEEP"}); err != nil {
		t.Fatalf("一个模型一个分组是合法的：%v", err)
	}
}

// 下架的、或者根本不存在的分组选不了：选中了也是一把调不动任何模型的密钥。
func TestValidateKeyGroupsRejectsUnknownOrUnlisted(t *testing.T) {
	svc, _, _ := banHarness(t, groupTable(
		[]driver.Value{"mg_OLD", "claude-opus-5", "老档", `[]`, false, false, nil},
	))
	for _, id := range []string{"mg_OLD", "mg_NOPE"} {
		if _, err := svc.validateKeyGroups(context.Background(), []string{id}); err == nil {
			t.Fatalf("分组 %q 不该能被选中", id)
		}
	}
}

// 派单的硬过滤：车道加入了才接这个分组的单；名单为空是「不限」，不是「都不接」。
//
// 把「不知道」当成「不接」，迁移那一刻全网机器会一起掉出候选，而界面上
// 每一台都还显示着「共享中」—— 那种故障只能从「一单也接不到」反推。
func TestGroupJoinedTreatsEmptyAsUnrestricted(t *testing.T) {
	if !groupJoined(nil, "mg_STD") {
		t.Fatal("没设名单的车道该什么都接")
	}
	if !groupJoined([]string{"mg_A"}, "") {
		t.Fatal("请求没有分组时该照常派得进去")
	}
	if !groupJoined([]string{"mg_A", "mg_STD"}, "mg_STD") {
		t.Fatal("加入了就该接")
	}
	if groupJoined([]string{"mg_A"}, "mg_STD") {
		t.Fatal("没加入的分组不该派过去")
	}
}
