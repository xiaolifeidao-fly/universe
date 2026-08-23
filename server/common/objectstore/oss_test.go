package objectstore

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
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
