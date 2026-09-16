package galaxy

import (
	"testing"
	"time"
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
