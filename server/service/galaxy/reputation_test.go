package galaxy

import (
	"context"
	"math"
	"strings"
	"testing"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

func TestEffectiveReputationRecoversDailyUpToFull(t *testing.T) {
	settledAt := mustTime(t, "2026-09-01T12:00:00Z")
	cases := []struct {
		name    string
		settled float64
		now     time.Time
		rate    float64
		want    float64
	}{
		{"刚扣完", 0.5, settledAt, 0.05, 0.5},
		{"一天回升一格", 0.5, settledAt.Add(24 * time.Hour), 0.05, 0.55},
		{"半天回升半格", 0.5, settledAt.Add(12 * time.Hour), 0.05, 0.525},
		{"回满就封顶", 0.5, settledAt.Add(30 * 24 * time.Hour), 0.05, 1},
		{"清零之后二十天回满", 0, settledAt.Add(20 * 24 * time.Hour), 0.05, 1},
		// 多实例时钟不齐：结算时刻在「此刻」之后，不能倒扣。
		{"时钟倒退不倒扣", 0.5, settledAt.Add(-time.Hour), 0.05, 0.5},
		{"不回升", 0.5, settledAt.Add(24 * time.Hour), 0, 0.5},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if got := EffectiveReputation(item.settled, settledAt, item.rate, item.now); math.Abs(got-item.want) > 1e-9 {
				t.Fatalf("EffectiveReputation = %v，期望 %v", got, item.want)
			}
		})
	}
}

func TestNormalizeFingerprintOnlyAcceptsSHA256Hex(t *testing.T) {
	valid := strings.Repeat("ab", 32)
	cases := map[string]string{
		valid:                             valid,
		strings.ToUpper(valid):            valid,
		"  " + valid + "\n":               valid,
		"":                                "",
		strings.Repeat("ab", 16):          "",
		strings.Repeat("zz", 32):          "",
		"node:" + strings.Repeat("a", 59): "",
	}
	for raw, want := range cases {
		if got := normalizeFingerprint(raw); got != want {
			t.Fatalf("normalizeFingerprint(%q) = %q，期望 %q", raw, got, want)
		}
	}
}

// 散户的信誉跟着账号：同一个人换一台电脑、同一台电脑重新配对，读的都是账号那一份。
func TestIndividualReputationFollowsTheAccount(t *testing.T) {
	laptop := &repository.GalaxyNode{NodeID: "n_laptop", OwnerUserID: "u_1", MachineFingerprint: strings.Repeat("aa", 32)}
	desktop := &repository.GalaxyNode{NodeID: "n_desktop", OwnerUserID: "u_1", MachineFingerprint: strings.Repeat("bb", 32)}
	legacy := &repository.GalaxyNode{NodeID: "n_legacy", OwnerUserID: "u_1"}
	want := "account:u_1"
	for _, node := range []*repository.GalaxyNode{laptop, desktop, legacy} {
		if got := reputationSubject(node, dto.ProviderIndividual); got != want {
			t.Fatalf("散户的 %s 读的是 %s，应当是账号那一份 %s", node.NodeID, got, want)
		}
	}
	// 身份没配（空串）也按散户：注册默认就是散户。
	if got := reputationSubject(laptop, ""); got != want {
		t.Fatalf("没有身份行的账号应当按散户读账号，实际 %s", got)
	}
}

// 工作室的信誉跟着设备：同一台机器解绑重配、甚至换一个账号去配，读的都是同一份；
// 同一个工作室的两台机器各算各的。
func TestStudioReputationFollowsTheDevice(t *testing.T) {
	fingerprint := strings.Repeat("cd", 32)
	before := &repository.GalaxyNode{NodeID: "n_before", OwnerUserID: "u_studio", MachineFingerprint: fingerprint}
	repaired := &repository.GalaxyNode{NodeID: "n_after", OwnerUserID: "u_other_studio", MachineFingerprint: fingerprint}
	if reputationSubject(before, dto.ProviderStudio) != reputationSubject(repaired, dto.ProviderStudio) {
		t.Fatal("同一台机器重新配对后，工作室的信誉换了地方")
	}
	sibling := &repository.GalaxyNode{NodeID: "n_sibling", OwnerUserID: "u_studio", MachineFingerprint: strings.Repeat("ef", 32)}
	if reputationSubject(before, dto.ProviderStudio) == reputationSubject(sibling, dto.ProviderStudio) {
		t.Fatal("工作室的两台机器不该共用一份信誉")
	}
	legacy := &repository.GalaxyNode{NodeID: "n_legacy", OwnerUserID: "u_studio"}
	if got := reputationSubject(legacy, dto.ProviderStudio); got != "node:n_legacy" {
		t.Fatalf("没报指纹的老节点只能拿节点当设备，实际 %s", got)
	}
}

// 管理端改身份不能让分数清零：扣分时账号和设备两份都记，改完读另一份，那份也一直在记。
func TestDeductionsLandOnBothAccountAndDevice(t *testing.T) {
	node := &repository.GalaxyNode{NodeID: "n_1", OwnerUserID: "u_1", MachineFingerprint: strings.Repeat("aa", 32)}
	written := map[string]bool{accountSubject(node.OwnerUserID): true, deviceSubject(node): true}
	for _, providerType := range []string{dto.ProviderIndividual, dto.ProviderStudio} {
		if subject := reputationSubject(node, providerType); !written[subject] {
			t.Fatalf("%s 读的 %s 不在扣分写入的那几份里：改身份之后分数就清零了", providerType, subject)
		}
	}
}

func TestSetProviderTypeRejectsUnknownTypes(t *testing.T) {
	svc := &service{}
	for _, req := range []dto.SetProviderTypeRequest{
		{OwnerUserID: "u_1", ProviderType: "vip"},
		{OwnerUserID: "u_1", ProviderType: ""},
		{OwnerUserID: "  ", ProviderType: dto.ProviderStudio},
	} {
		// 校验在碰库之前：service 上没有仓储，走到写库就会空指针崩。
		if err := svc.SetProviderType(context.Background(), req); err == nil {
			t.Fatalf("%+v 应当被拒", req)
		}
	}
}
