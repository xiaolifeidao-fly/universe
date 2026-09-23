package objectstore

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAliyunOSSPutUsesPathStyleSignedRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPut || request.URL.Path != "/delivery-private/cloud-sync/whatsapp/7/chat/object" {
			t.Fatalf("请求路径不正确：%s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") == "" || request.Header.Get("Content-MD5") == "" || request.Header.Get("x-oss-meta-sha256") != "abc123" {
			t.Fatalf("缺少 OSS 签名或元数据：%v", request.Header)
		}
		body, _ := io.ReadAll(request.Body)
		if string(body) != "hello" {
			t.Fatalf("OSS 上传正文不正确：%q", body)
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	client, err := NewAliyunOSS(OSSConfig{
		Endpoint: server.URL, Bucket: "delivery-private", AccessKeyID: "id", AccessKeySecret: "secret",
		Prefix: "cloud-sync", PathStyle: true, Now: func() time.Time { return time.Unix(0, 0) },
	})
	if err != nil {
		t.Fatalf("创建 OSS 客户端失败：%v", err)
	}
	key, err := client.Put(context.Background(), "whatsapp/7/chat/object", "text/markdown", []byte("hello"), "ABC123")
	if err != nil || key != "cloud-sync/whatsapp/7/chat/object" {
		t.Fatalf("OSS 上传结果不正确：key=%s err=%v", key, err)
	}
}

func TestNewAliyunOSSRejectsInvalidStorageSettings(t *testing.T) {
	if _, err := NewAliyunOSS(OSSConfig{Endpoint: "https://oss.example.com", Bucket: "bucket"}); err == nil {
		t.Fatal("缺少凭证必须拒绝")
	}
	if _, err := NewAliyunOSS(OSSConfig{Endpoint: "https://oss.example.com", Bucket: "../bucket", AccessKeyID: "id", AccessKeySecret: "secret"}); err == nil {
		t.Fatal("非法 bucket 必须拒绝")
	}
}

func TestAliyunOSSGetAndSignedURLKeepObjectPrivate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/delivery-private/cloud-sync/whatsapp/7/design/object" {
			t.Fatalf("请求路径不正确：%s", request.URL.Path)
		}
		if request.Method != http.MethodGet || request.Header.Get("Authorization") == "" || request.Header.Get("Date") == "" {
			t.Fatalf("服务器受控读取必须携带 GET 签名：%s %v", request.Method, request.Header)
		}
		writer.Header().Set("Content-Type", "text/markdown")
		_, _ = writer.Write([]byte("# design"))
	}))
	defer server.Close()
	now := time.Unix(1_700_000_000, 0)
	client, err := NewAliyunOSS(OSSConfig{
		Endpoint: server.URL, Bucket: "delivery-private", AccessKeyID: "id", AccessKeySecret: "secret",
		PathStyle: true, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("创建 OSS 客户端失败：%v", err)
	}
	object, err := client.Get(context.Background(), "cloud-sync/whatsapp/7/design/object")
	if err != nil || object.ContentType != "text/markdown" || string(object.Data) != "# design" {
		t.Fatalf("受控读取结果不正确：%#v %v", object, err)
	}
	signed, err := client.SignedURL("cloud-sync/whatsapp/7/design/object", now.Add(5*time.Minute))
	if err != nil || !strings.Contains(signed, "OSSAccessKeyId=id") || !strings.Contains(signed, "Signature=") {
		t.Fatalf("短时签名地址不正确：%q %v", signed, err)
	}
	if _, err := client.SignedURL("../secret", now.Add(time.Minute)); err == nil {
		t.Fatal("路径穿越必须拒绝")
	}
}

func TestAliyunOSSGetRejectsOversizedObject(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Length", "8388609")
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	client, err := NewAliyunOSS(OSSConfig{
		Endpoint: server.URL, Bucket: "delivery-private", AccessKeyID: "id", AccessKeySecret: "secret", PathStyle: true,
	})
	if err != nil {
		t.Fatalf("创建 OSS 客户端失败：%v", err)
	}
	if _, err := client.Get(context.Background(), "cloud-sync/oversized"); err == nil {
		t.Fatal("超出 8MB 的对象必须拒绝")
	}
}

// 服务端自己走 endpoint、交到别人手里的地址走 publicHost —— 这两件事分不开的话，
// 同区部署（endpoint 填 -internal 省流量）签出来的地址在 VPC 外解析不到：
// 运营的浏览器传不上去、用户的桌面壳取不到清单，而两边都只看到一个超时。
func TestAliyunOSSPublicHostOnlyAffectsOutboundURLs(t *testing.T) {
	var served int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		served++
		writer.Header().Set("Content-Type", "text/plain")
		_, _ = writer.Write([]byte("ok"))
	}))
	defer server.Close()
	now := time.Unix(1_700_000_000, 0)
	client, err := NewAliyunOSS(OSSConfig{
		Endpoint: server.URL, PublicHost: "https://oss-cn-hongkong.aliyuncs.com", Bucket: "galaxy-un",
		AccessKeyID: "id", AccessKeySecret: "secret",
		Prefix: "galaxy", PathStyle: true, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("创建 OSS 客户端失败：%v", err)
	}
	// 服务端自己的读取仍然打 endpoint（这里是那台 httptest）。
	if _, err := client.Get(context.Background(), "galaxy/orbit/latest-mac.yml"); err != nil || served != 1 {
		t.Fatalf("服务端读取没走 endpoint：served=%d err=%v", served, err)
	}
	// 签名地址与公开读地址走 publicHost。
	signed, err := client.SignedPutURL("galaxy/orbit/Orbit-0.1.0-arm64.zip", "application/zip", now.Add(time.Hour))
	if err != nil || !strings.HasPrefix(signed, "https://oss-cn-hongkong.aliyuncs.com/galaxy-un/galaxy/orbit/") {
		t.Fatalf("直传地址没走 publicHost：%q %v", signed, err)
	}
	// 空键＝prefix 本身，桌面壳的更新目录前缀就是这么来的。
	feed, err := client.PublicURL(client.ResolveKey(""))
	if err != nil || feed != "https://oss-cn-hongkong.aliyuncs.com/galaxy-un/galaxy" {
		t.Fatalf("更新目录前缀不对：%q %v", feed, err)
	}
	if served != 1 {
		t.Fatalf("签名与拼地址不该发请求：served=%d", served)
	}
}

// 不配 publicHost 的老部署行为必须一个字都不变。
func TestAliyunOSSFallsBackToEndpointWithoutPublicHost(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	client, err := NewAliyunOSS(OSSConfig{
		Endpoint: "https://oss-cn-hangzhou.aliyuncs.com", Bucket: "universe",
		AccessKeyID: "id", AccessKeySecret: "secret", Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("创建 OSS 客户端失败：%v", err)
	}
	signed, err := client.SignedURL("sku/a.png", now.Add(time.Minute))
	if err != nil || !strings.HasPrefix(signed, "https://universe.oss-cn-hangzhou.aliyuncs.com/sku/a.png?") {
		t.Fatalf("回落 endpoint 失败：%q %v", signed, err)
	}
	if _, err := NewAliyunOSS(OSSConfig{
		Endpoint: "https://oss.example.com", PublicHost: "ftp://oss.example.com", Bucket: "b",
		AccessKeyID: "id", AccessKeySecret: "secret",
	}); err == nil {
		t.Fatal("非法 publicHost 必须拒绝")
	}
}
