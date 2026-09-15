// Package local 只放本地装配适配器：把已有能力接成 service/galaxy 的 ports 形状。
// 不放业务 handler。
package local

import (
	"context"
	"time"

	"common/objectstore"
	"service/galaxy"
)

// ObjectSigner 把 common/objectstore 的 OSS 客户端接成共享池要的签名器。
// 共享池只签 URL，永远不经手产物字节（约束 3）。
type ObjectSigner struct {
	Storage *objectstore.AliyunOSS
}

func (s ObjectSigner) SignPut(_ context.Context, key, contentType string, _ int64, ttl time.Duration) (string, error) {
	return s.Storage.SignedPutURL(key, contentType, time.Now().Add(ttl))
}

func (s ObjectSigner) SignGet(_ context.Context, key string, ttl time.Duration) (string, error) {
	return s.Storage.SignedURL(key, time.Now().Add(ttl))
}

var _ galaxy.ObjectSigner = ObjectSigner{}
