package galaxy

import (
	"testing"
	"time"

	"service/galaxy/dto"
)

// 运行参数这套东西最容易错的不是「能不能改」，是**改错了会怎样**：
// 一个填得离谱的值落进去，池子会安静地停摆，而日志里什么都看不出来。

// TestSettingSpecsRoundTrip 每一项都要能「读出来再写回去」得到同一个值。
//
// read 与 apply 是一对：界面显示的是 read 的结果，运营改完提交回来走 apply。
// 两者对不上的后果是「打开页面不动任何东西、直接保存」就把值改了。
func TestSettingSpecsRoundTrip(t *testing.T) {
	config := DefaultConfig().withDefaults()
	for _, spec := range settingSpecs {
		raw := spec.read(config)
		if raw == "" && spec.Kind != SettingText {
			t.Errorf("%s 读出来是空的", spec.Key)
			continue
		}
		applied := config
		if err := spec.apply(&applied, raw); err != nil {
			t.Errorf("%s 读出来的值写不回去：%v", spec.Key, err)
			continue
		}
		if back := spec.read(applied); back != raw {
			t.Errorf("%s 来回一趟变了：%q → %q", spec.Key, raw, back)
		}
	}
}

// TestSettingDefaultsAreInsideTheirOwnRange 默认值必须落在自己声明的范围里。
//
// 不在的话，运营打开页面什么都没改就保存，会被自己的校验拒掉 ——
// 而他会以为是这一项坏了。
func TestSettingDefaultsAreInsideTheirOwnRange(t *testing.T) {
	config := DefaultConfig().withDefaults()
	for _, spec := range settingSpecs {
		if spec.Kind == SettingText {
			continue
		}
		raw := spec.read(config)
		// referral 那三项的默认值是「活动没开」（0），而范围下限也允许 0。
		if err := validateSetting(spec, raw); err != nil {
			t.Errorf("%s 的默认值 %s 不在它自己的范围里：%v", spec.Key, raw, err)
		}
	}
}

// TestValidateSettingRejectsValuesThatWouldStallThePool 范围不是装饰。
//
// max_wait 填成 3 毫秒，每一个请求都会在排到之前就超时 —— 池子看起来还活着，
// 但什么都跑不动，而这件事在任何一张监控图上都不会直接显示出来。
func TestValidateSettingRejectsValuesThatWouldStallThePool(t *testing.T) {
	spec, err := lookupSpec("placement.max_wait_ms")
	if err != nil {
		t.Fatalf("找不到这一项：%v", err)
	}
	if err := validateSetting(spec, "3"); err == nil {
		t.Fatal("3 毫秒的等待上限应当被拒")
	}
	if err := validateSetting(spec, "30000"); err != nil {
		t.Fatalf("30 秒应当是允许的：%v", err)
	}
}

// TestValidateSettingRejectsGarbage 非数字。
func TestValidateSettingRejectsGarbage(t *testing.T) {
	spec, _ := lookupSpec("payout.min_credits")
	for _, raw := range []string{"", "十万", "1e999999", "10.5.3"} {
		if err := validateSetting(spec, raw); err == nil {
			t.Errorf("%q 应当被拒", raw)
		}
	}
}

// TestLookupSpecRefusesUnknownKeys 只认这张表里的键。
//
// 放过去的后果不是报错：库里会多出一行谁也不读的数据，而运营以为自己改了什么。
func TestLookupSpecRefusesUnknownKeys(t *testing.T) {
	for _, key := range []string{"", "galaxy.instance", "galaxy.key_cipher_secret", "heartbeat_timeout_ms"} {
		if _, err := lookupSpec(key); err == nil {
			t.Errorf("%q 不该被当成可调参数", key)
		}
	}
}

// TestDeploymentFactsAreNotTunable 部署事实与密钥材料一项都不该在这张表里。
//
// 逐个点名，而不是只数个数：将来谁顺手加一项，这个用例要能指出加错了哪一个。
//
// 客户端安装包的下载地址曾经也在这张清单上（跟着配置文件走）。它被挪进来是有意的：
// 没有流量走它，填错只是某一页上多一条坏链接，而管理端要展示它 —— 留在配置文件里
// 就得在两个进程的两份文件里各配一遍。判据是「改它会不会让这套部署换个位置」，
// 不是「它长得像不像一个地址」。
func TestDeploymentFactsAreNotTunable(t *testing.T) {
	forbidden := []string{
		"galaxy.instance", "galaxy.consumer_base_url", "galaxy.provider_hub_url",
		"galaxy.key_cipher_secret", "bridge_release.public_keys",
		"galaxy.contract_version", "galaxy.heartbeat_timeout_ms", "galaxy.payout_rate",
		"payout.rate", "contract.version", "heartbeat.timeout_ms",
	}
	for _, key := range forbidden {
		if _, known := settingSpecByKey[key]; known {
			t.Errorf("%s 不该是可调参数", key)
		}
	}
}

// TestClientDownloadURLsAreValidated 下载地址会原样进 <a href>，
// 所以它是文本型里唯一需要校验的一类：只收 http(s)，其余一概拒。
//
// 校验写在 apply 里，所以保存接口和进程回查（loadSettings）走的是同一道 ——
// 手工改库塞进去的 javascript: 会在回查时被跳过，而不是被摆到页面上。
func TestClientDownloadURLsAreValidated(t *testing.T) {
	keys := []string{}
	for _, prefix := range []string{SettingClientProviderDownloadURL, SettingClientConsumerDownloadURL} {
		keys = append(keys, prefix)
		for _, platform := range dto.DesktopPlatforms {
			keys = append(keys, clientDownloadKey(prefix, platform))
		}
	}
	for _, key := range keys {
		spec, err := lookupSpec(key)
		if err != nil {
			t.Fatalf("%s 应当是可调参数：%v", key, err)
		}
		for _, raw := range []string{"https://www.galaxy.rodeo/download", "http://192.168.1.9:8080/nova.dmg"} {
			if err := validateSetting(spec, raw); err != nil {
				t.Errorf("%s 应当收下 %q：%v", key, raw, err)
			}
		}
		for _, raw := range []string{"javascript:alert(1)", "www.galaxy.rodeo/download", "Nova-0.1.0.dmg", "/downloads/nova.dmg"} {
			if err := validateSetting(spec, raw); err == nil {
				t.Errorf("%s 不该收下 %q", key, raw)
			}
		}
	}
}

// TestCfgFallsBackWithoutARepository 没有仓储的 service 读参数要退回配置文件那份，
// 而不是空指针。测试里有一批只验入参校验的 service 字面量走这条路。
func TestCfgFallsBackWithoutARepository(t *testing.T) {
	svc := &service{config: Config{MaxWait: 42 * time.Second}}
	if got := svc.cfg().MaxWait; got != 42*time.Second {
		t.Fatalf("应当退回配置文件那份，实际 %v", got)
	}
}

// TestLoadSettingsSkipsWhatItCannotUse 库里的脏行不该让整份配置失效。
//
// 两种脏：键不认识（降级部署时新版本写进去的），值非法（手工改库改出来的）。
// 任何一种让 loadSettings 整个报错，都会把这个进程打回一整套默认参数 ——
// 那比忽略一行严重得多。
func TestLoadSettingsSkipsWhatItCannotUse(t *testing.T) {
	base := DefaultConfig().withDefaults()
	merged := base

	// 认不出来的键：跳过。
	if _, known := settingSpecByKey["something.from.the.future"]; known {
		t.Fatal("这个键本来就不该存在")
	}

	// 非法值：校验挡住，不写进去。
	spec := settingSpecByKey["placement.max_wait_ms"]
	if err := validateSetting(spec, "3"); err == nil {
		t.Fatal("非法值应当被校验挡住")
	}
	if merged.MaxWait != base.MaxWait {
		t.Fatal("被挡住的值不该改动配置")
	}
}

// TestClientDownloadSlotsCoverEveryPlatform 管理端那张卡片是照服务端给的行画的：
// 少一行就是界面上少一个能填的平台，而那种缺失没有任何一处会报错。
//
// 顺带钉住两件在改名时最容易各改一半的事：分平台的键名是「前缀 + . + 平台」，
// 以及通用那一行用的就是原来那个键 —— 老部署升上来，运营填过的那条要原样还在。
func TestClientDownloadSlotsCoverEveryPlatform(t *testing.T) {
	urls := dto.DesktopDownloadURLs{
		Default:  "https://www.galaxy.rodeo/download",
		Windows:  "https://oss.example.com/Nova-0.1.0-win.exe",
		MacX64:   "https://oss.example.com/Nova-0.1.0-x64.zip",
		MacArm64: "https://oss.example.com/Nova-0.1.0-arm64.zip",
	}
	slots := ClientDownloadSlots(SettingClientProviderDownloadURL, urls)
	if len(slots) != len(dto.DesktopPlatforms)+1 {
		t.Fatalf("应当是通用那条加每个平台一条，实际 %d 条", len(slots))
	}
	if slots[0].Platform != "" || slots[0].SettingKey != SettingClientProviderDownloadURL {
		t.Fatalf("第一行应当是通用下载页、用原来那个键，实际 %+v", slots[0])
	}
	want := map[string]string{
		"":                          urls.Default,
		dto.DesktopPlatformWindows:  urls.Windows,
		dto.DesktopPlatformMacX64:   urls.MacX64,
		dto.DesktopPlatformMacArm64: urls.MacArm64,
	}
	for _, slot := range slots {
		if slot.URL != want[slot.Platform] {
			t.Errorf("%s 那一行摆的是 %q，应当是 %q", slot.Platform, slot.URL, want[slot.Platform])
		}
		if _, known := settingSpecByKey[slot.SettingKey]; !known {
			t.Errorf("%s 不是可调参数：界面照它提交会被顶回来", slot.SettingKey)
		}
	}
}

// TestClientDownloadSlotsShowWhatIsStored 卡片上的空格子要如实显示成「未填写」。
//
// 不走 Pick 是有意的：退回通用那条会让四行看着都填过，运营下一步就会去清一个
// 根本不存在的值 —— 而「清除」删的是库里那一行，删一个不存在的行什么也不会发生，
// 页面上那条地址却还在，看着像没生效。
func TestClientDownloadSlotsShowWhatIsStored(t *testing.T) {
	slots := ClientDownloadSlots(SettingClientConsumerDownloadURL, dto.DesktopDownloadURLs{
		Default: "https://www.galaxy.rodeo/download",
	})
	for _, slot := range slots {
		if slot.Platform == "" {
			continue
		}
		if slot.URL != "" {
			t.Errorf("%s 没填过，不该摆出 %q", slot.Platform, slot.URL)
		}
	}
}

// TestDesktopDownloadPickFallsBackToDefault 取地址的那一路反过来：平台没填就用通用页。
//
// 认不出来的平台也走通用页 —— 界面传来一个我们还不认识的平台名时，
// 给一条下载页比给空串好：用户至少能自己在那一页上挑。
func TestDesktopDownloadPickFallsBackToDefault(t *testing.T) {
	urls := dto.DesktopDownloadURLs{
		Default:  "https://www.galaxy.rodeo/download",
		MacArm64: "https://oss.example.com/Orbit-0.1.0-arm64.zip",
	}
	if got := urls.Pick(dto.DesktopPlatformMacArm64); got != urls.MacArm64 {
		t.Errorf("填过的平台应当用自己那条，实际 %q", got)
	}
	for _, platform := range []string{"", dto.DesktopPlatformWindows, dto.DesktopPlatformMacX64, "linux-x64"} {
		if got := urls.Pick(platform); got != urls.Default {
			t.Errorf("%q 应当退回通用页，实际 %q", platform, got)
		}
	}
	if (dto.DesktopDownloadURLs{}).Any() {
		t.Error("一条都没填时 Any 应当是 false —— 界面靠它决定那一块显不显示")
	}
	if !urls.Any() {
		t.Error("填过就该是 true")
	}
}
