package galaxy

import (
	"strings"
	"testing"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 回连地址是提供者自己填的，Hub 会拿着它主动发请求 —— 这一组规则就是
// 「Hub 会去访问什么」的边界，每一条被放宽都应该有人在测试里看见。
func TestNormalizeEndpointURL(t *testing.T) {
	accepted := map[string]string{
		"https://box.example.com:8788/":   "https://box.example.com:8788",
		" http://10.0.0.8:8788 ":          "http://10.0.0.8:8788",
		"https://box.example.com/bridge/": "https://box.example.com/bridge",
	}
	for raw, want := range accepted {
		got, err := normalizeEndpointURL(raw)
		if err != nil || got != want {
			t.Fatalf("%q → (%q, %v)，想要 %q", raw, got, err, want)
		}
	}
	rejected := []string{
		"",
		"ftp://box.example.com",
		"https://user:pw@box.example.com",
		"https://box.example.com/?a=b",
		"https://box.example.com/#x",
		"https://",
		// 链路本地地址没有任何合法用途，而 169.254.169.254 是各家云的元数据服务。
		"http://169.254.169.254/latest/meta-data",
		"http://[fe80::1]:8788",
	}
	for _, raw := range rejected {
		if got, err := normalizeEndpointURL(raw); err == nil {
			t.Fatalf("%q 应该被拒，却得到 %q", raw, got)
		}
	}
}

func TestValidateEndpointRequiresALongEnoughSecret(t *testing.T) {
	if _, _, err := validateEndpoint(nil); err == nil {
		t.Fatal("export 不带回连信息应该被拒")
	}
	short := &dto.ExportEndpointInput{URL: "https://box.example.com", Secret: strings.Repeat("s", minEndpointSecret-1)}
	if _, _, err := validateEndpoint(short); err == nil {
		t.Fatal("短密钥应该被拒：它是公网上唯一拦住陌生人的东西")
	}
	long := &dto.ExportEndpointInput{URL: "https://box.example.com", Secret: strings.Repeat("s", 129)}
	if _, _, err := validateEndpoint(long); err == nil {
		t.Fatal("超长密钥应该被拒：列宽只有 128")
	}
	url, secret, err := validateEndpoint(&dto.ExportEndpointInput{
		URL: "https://box.example.com:8788/", Secret: "  " + strings.Repeat("s", minEndpointSecret) + "  ",
	})
	if err != nil || url != "https://box.example.com:8788" || secret != strings.Repeat("s", minEndpointSecret) {
		t.Fatalf("合法的回连信息被改坏了：(%q, %q, %v)", url, secret, err)
	}
}

// 接入方式是节点自己声明的，拼错不该让机器连不上来 —— 回落到 poll 是安全的那一侧。
func TestNormalizeAccessModeFallsBackToPoll(t *testing.T) {
	cases := map[string]string{"export": dto.AccessModeExport, "poll": dto.AccessModePoll, "": dto.AccessModePoll, "EXPORT": dto.AccessModePoll, "push": dto.AccessModePoll}
	for raw, want := range cases {
		if got := dto.NormalizeAccessMode(raw); got != want {
			t.Fatalf("%q → %q，想要 %q", raw, got, want)
		}
	}
}

// 派单器只回连「信息完整、没被撤销也没被封禁」的机器。任何一条漏掉，
// Hub 都会去敲一扇不该敲的门。
func TestExportTargetOnlyForUsableExportNodes(t *testing.T) {
	base := repository.GalaxyNode{
		NodeID: "n_1", AccessMode: dto.AccessModeExport, Status: "active", TokenHash: "hash",
		EndpointURL: "https://box.example.com:8788", EndpointSecret: strings.Repeat("s", minEndpointSecret),
	}
	target, ok := exportTargetOfRow(&base)
	if !ok || target.ExecuteURL() != "https://box.example.com:8788/node/v1/execute" || target.Secret != base.EndpointSecret {
		t.Fatalf("完整的 export 机器应当被回连：%+v %v", target, ok)
	}
	for name, mutate := range map[string]func(*repository.GalaxyNode){
		"poll 接入": func(row *repository.GalaxyNode) { row.AccessMode = dto.AccessModePoll },
		"没有回连地址":  func(row *repository.GalaxyNode) { row.EndpointURL = "" },
		"没有回连密钥":  func(row *repository.GalaxyNode) { row.EndpointSecret = "" },
		"平台封禁":    func(row *repository.GalaxyNode) { row.Banned = true },
		"主人撤销":    func(row *repository.GalaxyNode) { row.Status = "revoked" },
		"令牌已清空":   func(row *repository.GalaxyNode) { row.TokenHash = "" },
	} {
		row := base
		mutate(&row)
		if _, ok := exportTargetOfRow(&row); ok {
			t.Fatalf("%s 的机器不该被回连", name)
		}
	}
	if _, ok := exportTargetOfRow(nil); ok {
		t.Fatal("nil 不该被回连")
	}
}
