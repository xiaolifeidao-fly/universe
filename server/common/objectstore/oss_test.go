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
