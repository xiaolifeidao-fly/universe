package galaxy

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 一份真实形状的 latest-mac.yml（electron-builder 26 出的就是这个样子）。
const macManifest = `version: 0.1.1
files:
  - url: Nova-0.1.1-arm64-mac.zip
    sha512: 6Zk9xQnBZ0Q1Yb1Yl6r2JmH0G1w0k2sQ0oQpI3s5dQx1k2n3M4p5Q6r7S8t9U0v1W2x3Y4z5A6b7C8d9E0f1g==
    size: 118293841
    blockMapSize: 126271
  - url: Nova-0.1.1-arm64.dmg
    sha512: 7Zk9xQnBZ0Q1Yb1Yl6r2JmH0G1w0k2sQ0oQpI3s5dQx1k2n3M4p5Q6r7S8t9U0v1W2x3Y4z5A6b7C8d9E0f1g==
    size: 122934112
path: Nova-0.1.1-arm64-mac.zip
sha512: 6Zk9xQnBZ0Q1Yb1Yl6r2JmH0G1w0k2sQ0oQpI3s5dQx1k2n3M4p5Q6r7S8t9U0v1W2x3Y4z5A6b7C8d9E0f1g==
releaseDate: '2026-09-18T04:21:07.336Z'
`

// 清单是 electron-builder 的产物，我们只校验、不重写它的语义。
// 这里钉的是「能解析出发布要用的那几样」。
func TestParseDesktopManifestReadsVersionAndFiles(t *testing.T) {
	doc, err := parseDesktopManifest(macManifest, dto.DesktopChannelMac)
	if err != nil {
		t.Fatalf("真实的 latest-mac.yml 必须能解析：%v", err)
	}
	if doc.manifest.Version != "0.1.1" {
		t.Fatalf("版本解析错了：%q", doc.manifest.Version)
	}
	if len(doc.manifest.Files) != 2 || doc.manifest.Files[0].URL != "Nova-0.1.1-arm64-mac.zip" {
		t.Fatalf("文件清单解析错了：%+v", doc.manifest.Files)
	}
	if doc.manifest.Files[0].Size != 118293841 {
		t.Fatalf("文件大小解析错了：%d", doc.manifest.Files[0].Size)
	}
}

// 下面每一条都对应一种「发布看着成功、客户端却更新不了」的故障 ——
// 而那种故障要等用户那边不更新才被发现，所以必须在收下清单的这一刻就拦住。
func TestParseDesktopManifestRejectsManifestsThatWouldBreakClients(t *testing.T) {
	replace := func(old, new string) string { return strings.Replace(macManifest, old, new, 1) }
	bad := map[string]struct {
		manifest string
		channel  string
	}{
		"版本号不是语义版本，客户端比不出新旧":      {replace("version: 0.1.1", "version: v0.1.1"), dto.DesktopChannelMac},
		"文件名带路径，会被当成对象键的一部分":      {replace("url: Nova-0.1.1-arm64-mac.zip", "url: mac/Nova-0.1.1-arm64-mac.zip"), dto.DesktopChannelMac},
		"文件名带空格，两边的转义规则不一样":       {replace("url: Nova-0.1.1-arm64.dmg", "url: Nova Setup 0.1.1.dmg"), dto.DesktopChannelMac},
		"没有 sha512，客户端没法校验下载下来的包": {replace("sha512: 7Zk9", "sha512: \nx: 7Zk9"), dto.DesktopChannelMac},
		"path 指向清单里没有的文件，下载会 404": {replace("path: Nova-0.1.1-arm64-mac.zip", "path: Nova-0.1.0-arm64-mac.zip"), dto.DesktopChannelMac},
		"mac 没有 zip，Squirrel 装不了": {replace("url: Nova-0.1.1-arm64-mac.zip", "url: Nova-0.1.1-arm64-mac.tar"), dto.DesktopChannelMac},
		"windows 的清单里没有 exe":      {macManifest, dto.DesktopChannelWin},
		"根本不是 yml":                {"not a manifest: [", dto.DesktopChannelMac},
		"空的":                      {"", dto.DesktopChannelMac},
	}
	for why, item := range bad {
		if _, err := parseDesktopManifest(item.manifest, item.channel); err == nil {
			t.Errorf("%s：应当被拒绝", why)
		}
	}
}

// 通道从清单文件名认。名字是 electron-updater 定死的，认错了等于把 mac 的清单
// 发到 windows 的地址上 —— 那一端会安静地永远收不到更新。
func TestDesktopChannelOfAcceptsOnlyTheThreeRealNames(t *testing.T) {
	for name, want := range map[string]string{
		"latest-mac.yml":   dto.DesktopChannelMac,
		"latest.yml":       dto.DesktopChannelWin,
		"latest-linux.yml": dto.DesktopChannelLinux,
	} {
		got, err := desktopChannelOf(name)
		if err != nil || got != want {
			t.Errorf("%s 应当是 %s 通道，得到 %q %v", name, want, got, err)
		}
	}
	for _, name := range []string{"builder-debug.yml", "latest-mac.yaml", "latest-darwin.yml", "", "latest-mac.yml.bak"} {
		if _, err := desktopChannelOf(name); err == nil {
			t.Errorf("%q 不该被当成清单", name)
		}
	}
}

// 版本说明要进清单：客户端的更新提示上显示的就是它。
// 同时，清单里我们不认识的字段必须原样留着 —— 它们跟着 electron-builder 走。
func TestSetDesktopNotesKeepsEverythingElseIntact(t *testing.T) {
	doc, err := parseDesktopManifest(macManifest, dto.DesktopChannelMac)
	if err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	if err := setDesktopNotes(doc, "修好了托盘图标\n升级不再要求重新登录"); err != nil {
		t.Fatalf("写版本说明失败：%v", err)
	}
	out, err := yaml.Marshal(doc.node)
	if err != nil {
		t.Fatalf("清单写不回去：%v", err)
	}
	text := string(out)
	if !strings.Contains(text, "releaseNotes") || !strings.Contains(text, "修好了托盘图标") {
		t.Fatalf("版本说明没进清单：\n%s", text)
	}
	// 多行说明要用字面量块，普通标量会把换行折成空格，客户端上看到的是挤成一行的说明。
	if !strings.Contains(text, "releaseNotes: |-") {
		t.Fatalf("多行说明应当用字面量块：\n%s", text)
	}
	// 我们不认识、也没打算认识的字段（blockMapSize / releaseDate）必须还在。
	for _, keep := range []string{"blockMapSize", "releaseDate", "Nova-0.1.1-arm64.dmg"} {
		if !strings.Contains(text, keep) {
			t.Errorf("%s 被写没了：\n%s", keep, text)
		}
	}
	// 写回去的东西还要能再被解析一遍 —— 客户端拿到的就是这份字节。
	again, err := parseDesktopManifest(text, dto.DesktopChannelMac)
	if err != nil {
		t.Fatalf("写回去的清单自己解析不了：%v", err)
	}
	if again.manifest.Version != "0.1.1" || len(again.manifest.Files) != 2 {
		t.Fatalf("回写之后内容变了：%+v", again.manifest)
	}
}

// 说明清空就要把这个键去掉，而不是留一个空串：客户端拿空串会画一块空的「更新内容」。
func TestSetDesktopNotesRemovesTheKeyWhenCleared(t *testing.T) {
	doc, err := parseDesktopManifest(macManifest, dto.DesktopChannelMac)
	if err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	if err := setDesktopNotes(doc, "第一版说明"); err != nil {
		t.Fatalf("写版本说明失败：%v", err)
	}
	if err := setDesktopNotes(doc, "   "); err != nil {
		t.Fatalf("清空版本说明失败：%v", err)
	}
	out, _ := yaml.Marshal(doc.node)
	if strings.Contains(string(out), "releaseNotes") {
		t.Fatalf("清空之后不该还留着这个键：\n%s", out)
	}
}

// 上传时带的 Content-Type 参与签名，对不上 OSS 直接拒。所以它由服务端定，
// 不让浏览器按后缀猜（同一个 .AppImage 在不同系统上猜出来的类型不一样）。
func TestDesktopContentTypeIsDecidedByTheServer(t *testing.T) {
	for name, want := range map[string]string{
		"Nova-0.1.1-arm64-mac.zip": "application/zip",
		"Nova-0.1.1-arm64.dmg":     "application/x-apple-diskimage",
		"latest-mac.yml":           "text/yaml; charset=utf-8",
		"Nova-0.1.1-x64.exe":       "application/octet-stream",
		"Nova-0.1.1-x64.AppImage":  "application/octet-stream",
	} {
		if got := desktopContentType(name); got != want {
			t.Errorf("%s 的类型应当是 %s，得到 %s", name, want, got)
		}
	}
}

// 列表的顺序：端固定在前，同一个端里版本新的在前。按字符串排的话
// 0.10.0 会排到 0.9.0 后面，运营会以为发错了版本。
func TestSortDesktopReleasesOrdersByProductThenVersion(t *testing.T) {
	rows := []*repository.GalaxyDesktopRelease{
		{Product: "orbit", Channel: dto.DesktopChannelMac, Version: "0.9.0"},
		{Product: "nova", Channel: dto.DesktopChannelWin, Version: "0.9.0"},
		{Product: "nova", Channel: dto.DesktopChannelMac, Version: "0.10.0"},
		{Product: "nova", Channel: dto.DesktopChannelMac, Version: "0.9.0"},
	}
	sortDesktopReleases(rows)
	got := make([]string, 0, len(rows))
	for _, row := range rows {
		got = append(got, row.Product+"/"+row.Channel+"/"+row.Version)
	}
	want := []string{"nova/mac/0.10.0", "nova/mac/0.9.0", "nova/win/0.9.0", "orbit/mac/0.9.0"}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("顺序不对：%v，想要 %v", got, want)
		}
	}
}

// 对象键必须把部署配置的 dirPrefix 带上：清单由服务端写、安装包由浏览器直传，
// 两条路只要有一条漏了前缀，它们就会落在两个目录里 —— 发布成功，客户端 404。
func TestDesktopObjectKeyCarriesTheDeploymentPrefix(t *testing.T) {
	// 端目录直接挂在部署前缀下，和 ai-bridge 的包平级（<prefix>/ai-bridge/…）。
	store := prefixStore("galaxy/app")
	if got := desktopObjectKey(store, "nova", "latest-mac.yml"); got != "galaxy/app/nova/latest-mac.yml" {
		t.Fatalf("对象键不对：%q", got)
	}
	if got := desktopObjectKey(prefixStore(""), "orbit", "Orbit-0.1.1-arm64-mac.zip"); got != "orbit/Orbit-0.1.1-arm64-mac.zip" {
		t.Fatalf("没配前缀时的对象键不对：%q", got)
	}
}

// prefixStore 是 keyResolver 的桩：部署配置里的 dirPrefix。
type prefixStore string

func (p prefixStore) ResolveKey(objectKey string) string {
	if p == "" {
		return objectKey
	}
	return string(p) + "/" + objectKey
}
