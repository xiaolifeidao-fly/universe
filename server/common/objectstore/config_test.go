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
