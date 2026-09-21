package objectstore

import (
	"testing"
	"time"
)

func TestLoadAliyunOSSDeploymentUsesStandardProperties(t *testing.T) {
	values := map[string]string{
		"oss.enabled":         "true",
		"oss.dirPrefix":       "sku",
		"oss.endpoint":        "oss-cn-hangzhou-internal.aliyuncs.com",
		"oss.bucketName":      "universe",
		"oss.accessKeyId":     "id",
		"oss.accessKeySecret": "secret",
		"oss.expireTime":      "600",
		"oss.callbackUrl":     "https://api.example.com/oss/callback",
		"oss.tokenExpireTime": "300",
	}
	config, err := LoadAliyunOSSDeployment(func(key string) string { return values[key] })
	if err != nil {
		t.Fatalf("读取 OSS 配置失败: %v", err)
	}
	if !config.Enabled || config.Storage.Endpoint != "https://oss-cn-hangzhou-internal.aliyuncs.com" ||
		config.Storage.Bucket != "universe" || config.Storage.Prefix != "sku" ||
		config.Storage.AccessKeyID != "id" || config.Storage.AccessKeySecret != "secret" ||
		config.SignedURLTTL != 10*time.Minute || config.TokenTTL != 5*time.Minute ||
		config.CallbackURL != "https://api.example.com/oss/callback" {
		t.Fatalf("OSS 配置映射错误: %#v", config)
	}
}

func TestLoadAliyunOSSDeploymentSkipsDisabledStorage(t *testing.T) {
	config, err := LoadAliyunOSSDeployment(func(key string) string {
		if key == "oss.enabled" {
			return "false"
		}
		return "invalid"
	})
	if err != nil || config.Enabled {
		t.Fatalf("禁用 OSS 不应校验其余字段: config=%#v err=%v", config, err)
	}
	client, err := config.NewClient()
	if err != nil || client != nil {
		t.Fatalf("禁用 OSS 不应初始化客户端: client=%#v err=%v", client, err)
	}
}

func TestLoadAliyunOSSDeploymentRejectsInvalidDurations(t *testing.T) {
	_, err := LoadAliyunOSSDeployment(func(key string) string {
		if key == "oss.enabled" {
			return "true"
		}
		if key == "oss.expireTime" {
			return "0"
		}
		return ""
	})
	if err == nil {
		t.Fatal("无效有效期必须拒绝")
	}
}

// publicHost 和 endpoint 一样允许省略协议头，省得部署配置里两行写法不一致。
func TestLoadAliyunOSSDeploymentReadsPublicHost(t *testing.T) {
	values := map[string]string{
		"oss.enabled": "true", "oss.dirPrefix": "galaxy",
		"oss.endpoint": "oss-cn-hongkong-internal.aliyuncs.com", "oss.publicHost": "oss-cn-hongkong.aliyuncs.com",
		"oss.bucketName": "galaxy-un", "oss.accessKeyId": "id", "oss.accessKeySecret": "secret",
	}
	config, err := LoadAliyunOSSDeployment(func(key string) string { return values[key] })
	if err != nil {
		t.Fatalf("读取 OSS 配置失败: %v", err)
	}
	if config.Storage.Endpoint != "https://oss-cn-hongkong-internal.aliyuncs.com" ||
		config.Storage.PublicHost != "https://oss-cn-hongkong.aliyuncs.com" {
		t.Fatalf("publicHost 映射错误: %#v", config.Storage)
	}
	delete(values, "oss.publicHost")
	if config, err = LoadAliyunOSSDeployment(func(key string) string { return values[key] }); err != nil || config.Storage.PublicHost != "" {
		t.Fatalf("不配 publicHost 应保持空串（由客户端回落到 endpoint）: %#v %v", config.Storage, err)
	}
}

// 更新目录前缀不签名，所以凭证留空也要能算出来 —— 不然一个只想把更新地址报给
// 桌面壳的部署会因为「没填 accessKey」而整个不检查更新。
func TestPublicPrefixURLNeedsNoCredentials(t *testing.T) {
	values := map[string]string{
		"oss.enabled": "true", "oss.dirPrefix": "galaxy", "oss.bucketName": "galaxy-un",
		"oss.endpoint": "oss-cn-hongkong-internal.aliyuncs.com", "oss.publicHost": "oss-cn-hongkong.aliyuncs.com",
	}
	config, err := LoadAliyunOSSDeployment(func(key string) string { return values[key] })
	if err != nil {
		t.Fatalf("读取 OSS 配置失败: %v", err)
	}
	if _, err := config.NewClient(); err == nil {
		t.Fatal("没有凭证时客户端应当建不起来（前提条件，说明前缀地址不依赖它）")
	}
	base, err := config.PublicPrefixURL()
	if err != nil || base != "https://galaxy-un.oss-cn-hongkong.aliyuncs.com/galaxy" {
		t.Fatalf("更新目录前缀不对: %q %v", base, err)
	}
	// 不配 publicHost 就回落到 endpoint —— 同区部署要记得这时签出去的是内网域名。
	delete(values, "oss.publicHost")
	config, _ = LoadAliyunOSSDeployment(func(key string) string { return values[key] })
	if base, err = config.PublicPrefixURL(); err != nil || base != "https://galaxy-un.oss-cn-hongkong-internal.aliyuncs.com/galaxy" {
		t.Fatalf("回落 endpoint 失败: %q %v", base, err)
	}
	// 没装对象存储就是空串，不是错误：那个部署不检查更新。
	values["oss.enabled"] = "false"
	config, _ = LoadAliyunOSSDeployment(func(key string) string { return values[key] })
	if base, err = config.PublicPrefixURL(); err != nil || base != "" {
		t.Fatalf("未启用时应当是空串: %q %v", base, err)
	}
}
