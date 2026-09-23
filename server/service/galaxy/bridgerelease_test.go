package galaxy

import (
	"strings"
	"testing"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 包名是版本与平台的唯一来源，所以它错一点都不能放过：
// 一个被登记成 0.2.1 的 0.2.0 包，会让所有机器认为自己已经是最新的。
func TestParseBridgePackageNameAcceptsOnlyTheRealShape(t *testing.T) {
	version, platform, err := ParseBridgePackageName("ai-bridge-0.2.0-linux-x64.tar.gz")
	if err != nil || version != "0.2.0" || platform != "linux-x64" {
		t.Fatalf("正常包名应当解析出版本与平台，得到 %q %q %v", version, platform, err)
	}
	if _, _, err := ParseBridgePackageName("ai-bridge-0.2.0-rc.1-windows-x64.zip"); err != nil {
		t.Fatalf("预发布版本也该认：%v", err)
	}

	bad := map[string]string{
		"ai-bridge-0.2.0-linux-x64.zip":      "linux 的包是 tar.gz，zip 要拦下来",
		"ai-bridge-0.2.0-windows-x64.tar.gz": "windows 的包是 zip",
		"ai-bridge-0.2.0-plan9-x64.tar.gz":   "不认识的平台",
		"ai-bridge-v0.2.0-linux-x64.tar.gz":  "版本号不该带 v",
		"ai-bridge-linux-x64.tar.gz":         "少了版本号",
		"ai-bridge-0.2.0-linux-x64.tar":      "不是认识的压缩格式",
	}
	for name, why := range bad {
		if _, _, err := ParseBridgePackageName(name); err == nil {
			t.Errorf("%s：%q 应当被拒绝", why, name)
		}
	}
}

// 版本比较按字符串做的话，0.10.0 会比 0.9.0 小 —— 一次小版本号进位，
// 所有机器都会认为自己已经是最新的，升级功能整个静默失效。
func TestCompareBridgeVersionsOrdersNumericallyAndRanksPreReleasesLower(t *testing.T) {
	cases := []struct {
		left, right string
		want        int
	}{
		{"0.10.0", "0.9.0", 1},
		{"0.9.0", "0.10.0", -1},
		{"1.0.0", "0.99.99", 1},
		{"0.2.0", "0.2.0", 0},
		{"0.2.1", "0.2.0", 1},
		{"0.2.0", "0.2.0-rc.1", 1},
		{"0.2.0-rc.1", "0.2.0", -1},
		{"0.2.0-rc.2", "0.2.0-rc.1", 1},
		// 老节点报不上版本（空串）时，任何一版都算更新 —— 否则它永远升不了。
		{"0.1.0", "", 1},
	}
	for _, item := range cases {
		if got := compareBridgeVersions(item.left, item.right); got != item.want {
			t.Errorf("compareBridgeVersions(%q, %q) = %d，想要 %d", item.left, item.right, got, item.want)
		}
	}
}

// 发布签名的测试向量由节点侧的签名脚本（scripts/release-sign.cjs）生成。
//
// 它钉住的是**两个实现对同一份字节的理解**：Go 这边验、Rust 那边也验，
// 被签名的消息差一个换行，线上就会表现成「所有机器都拒装新版本」。
const (
	testReleasePublicKey = "+XdUKJVKJM5EuRq8pL4dB1Wl179yB4J/tvlOZvfoiCY="
	testReleaseVersion   = "0.1.0"
	testReleasePlatform  = "linux-x64"
	testReleaseDigest    = "29497afb2668d3c372667f69ff807863db4201b937de100d7cb4826c05ee527e"
	testReleaseSignature = "LdBrE8P8lqfbozfkhl4hx4cIaZ7ZAYtUdHeSZALB5+BNgKqRF8fOieo1hzId2mUxvOHIdNJYUT8v2Al8M/+2Bg=="
)

func TestVerifyBridgeSignatureMatchesTheNodeSideVector(t *testing.T) {
	keys := []string{testReleasePublicKey}
	if err := verifyBridgeSignature(keys, testReleaseVersion, testReleasePlatform, testReleaseDigest, testReleaseSignature); err != nil {
		t.Fatalf("节点侧生成的签名必须验得过：%v", err)
	}
	// 多配一把不认识的公钥不影响（换钥匙期间新旧并存）。
	if err := verifyBridgeSignature([]string{"AAAA", testReleasePublicKey}, testReleaseVersion, testReleasePlatform, testReleaseDigest, testReleaseSignature); err != nil {
		t.Fatalf("有一把验得过就该通过：%v", err)
	}

	// 签名覆盖三样东西：改任何一样都必须失败，否则一个旧版本的签名
	// 就能被贴到新版本号上（降级攻击），或者跨平台冒用。
	mutations := []struct {
		name                      string
		version, platform, digest string
	}{
		{"换了版本号", "0.2.0", testReleasePlatform, testReleaseDigest},
		{"换了平台", testReleaseVersion, "darwin-arm64", testReleaseDigest},
		{"包被改过", testReleaseVersion, testReleasePlatform, strings.Repeat("0", 64)},
	}
	for _, item := range mutations {
		if err := verifyBridgeSignature(keys, item.version, item.platform, item.digest, testReleaseSignature); err == nil {
			t.Errorf("%s 之后签名不该还验得过", item.name)
		}
	}

	if err := verifyBridgeSignature(nil, testReleaseVersion, testReleasePlatform, testReleaseDigest, testReleaseSignature); err == nil {
		t.Error("一把公钥都没配时必须拒绝，而不是放行")
	}
	if err := verifyBridgeSignature(keys, testReleaseVersion, testReleasePlatform, testReleaseDigest, "not-base64"); err == nil {
		t.Error("签名不是合法 base64 时必须拒绝")
	}
}

// 被签名的消息格式两端各写一遍，这里把它钉死。
func TestBridgeSignedMessageShape(t *testing.T) {
	got := string(bridgeSignedMessage("0.2.0", "linux-x64", "abc"))
	want := "ai-bridge-release:v1\n0.2.0\nlinux-x64\nabc\n"
	if got != want {
		t.Fatalf("被签名的消息变了：%q，想要 %q", got, want)
	}
}

// 卡住的升级要在视图里折算成失败：一行永远停在「正在下载」的机器，
// 主人既不知道该等还是该重试，也点不动按钮（进行中不让再点）。
func TestNodeUpgradeViewTurnsStuckUpgradesIntoFailures(t *testing.T) {
	now := time.Date(2026, 9, 12, 10, 0, 0, 0, time.UTC)
	fresh := now.Add(-time.Minute)
	stale := now.Add(-time.Hour)

	if view := nodeUpgradeView(&repository.GalaxyNode{}, now); view != nil {
		t.Fatal("从没升级过的机器不该有升级视图")
	}

	running := &repository.GalaxyNode{
		UpgradeID: "ug_1", UpgradeStatus: dto.UpgradeDownloading, UpgradeUpdatedAt: &fresh,
	}
	if view := nodeUpgradeView(running, now); view == nil || view.Status != dto.UpgradeDownloading {
		t.Fatalf("刚有进展的升级应当照原样显示，得到 %+v", view)
	}

	stuck := &repository.GalaxyNode{
		UpgradeID: "ug_2", UpgradeStatus: dto.UpgradeDownloading, UpgradeUpdatedAt: &stale,
	}
	view := nodeUpgradeView(stuck, now)
	if view == nil || view.Status != dto.UpgradeFailed || view.Message == "" {
		t.Fatalf("卡住太久的升级应当折算成失败并说明原因，得到 %+v", view)
	}

	// 已经结束的状态不受时间影响：一次两周前的成功仍然是成功。
	done := &repository.GalaxyNode{
		UpgradeID: "ug_3", UpgradeStatus: dto.UpgradeSucceeded, UpgradeUpdatedAt: &stale,
	}
	if view := nodeUpgradeView(done, now); view == nil || view.Status != dto.UpgradeSucceeded {
		t.Fatalf("终态不该被超时改写，得到 %+v", view)
	}
}

// 点不动的时候必须说得出为什么 —— 一个灰着的按钮旁边没有原因，
// 用户只会以为功能坏了。
func TestCheckNodeUpgradableExplainsEveryRefusal(t *testing.T) {
	base := func() *repository.GalaxyNode {
		return &repository.GalaxyNode{
			Status: statusActive, BridgeDistribution: distributionCLI, BridgePlatform: "linux-x64",
		}
	}
	if err := checkNodeUpgradable(base()); err != nil {
		t.Fatalf("在线的命令行节点应当可以升级：%v", err)
	}

	cases := []struct {
		name     string
		mutate   func(*repository.GalaxyNode)
		contains string
	}{
		{"封禁", func(n *repository.GalaxyNode) { n.Banned = true }, "停用"},
		{"已解绑", func(n *repository.GalaxyNode) { n.Status = "revoked" }, "解绑"},
		{"离线", func(n *repository.GalaxyNode) { n.Status = "offline" }, "不在线"},
		{"随 Nova 分发", func(n *repository.GalaxyNode) { n.BridgeDistribution = distributionNova }, "Nova"},
		{"老节点", func(n *repository.GalaxyNode) { n.BridgeDistribution = "" }, "版本太旧"},
		{"节点自报的障碍", func(n *repository.GalaxyNode) { n.UpgradeBlocker = "目录不可写" }, "目录不可写"},
		{"平台未知", func(n *repository.GalaxyNode) { n.BridgePlatform = "" }, "平台"},
	}
	for _, item := range cases {
		node := base()
		item.mutate(node)
		err := checkNodeUpgradable(node)
		if err == nil {
			t.Errorf("%s 的机器不该允许升级", item.name)
			continue
		}
		if !strings.Contains(err.Error(), item.contains) {
			t.Errorf("%s 的原因要说清楚，得到 %q", item.name, err.Error())
		}
	}
}

// 比例落进账本的是万分之一的整数：0.1 这种十进制小数在浮点里不是精确值，
// 直接拿它乘出来的钱对不齐账。
func TestReferralBpsRoundsAndClamps(t *testing.T) {
	cases := map[float64]int64{
		0:     0,
		-0.1:  0,
		0.1:   1000,
		0.05:  500,
		0.155: 1550,
		1:     10000,
		2:     10000, // 封顶 100%：配错了也不该返得比赚的还多
	}
	for rate, want := range cases {
		if got := referralBps(rate); got != want {
			t.Errorf("referralBps(%v) = %d，想要 %d", rate, got, want)
		}
	}
}

// 邀请链接是分享出去的那一串，拼错了整条链路就断在第一步。
func TestProviderInviteLink(t *testing.T) {
	svc := &service{config: Config{ReferralRegisterURL: "https://nova.example.com/register"}}
	if got := svc.providerInviteLink("ABCD2345"); got != "https://nova.example.com/register?invite=ABCD2345" {
		t.Fatalf("链接拼错了：%s", got)
	}
	// 配置里的地址已经带参数时要合并，不能拼成第二个问号。
	withQuery := &service{config: Config{ReferralRegisterURL: "https://nova.example.com/register?from=poster"}}
	got := withQuery.providerInviteLink("ABCD2345")
	if !strings.Contains(got, "invite=ABCD2345") || strings.Count(got, "?") != 1 {
		t.Fatalf("已有查询参数时要合并：%s", got)
	}
	// 没配注册页地址时给空串：一个打不开的链接比没有链接更糟。
	empty := &service{config: Config{}}
	if got := empty.providerInviteLink("ABCD2345"); got != "" {
		t.Fatalf("没配注册页地址时不该拼出链接：%s", got)
	}
}
