package delivery

import "context"

// CloudObjectStorage 是交付层对 OSS 的最小依赖。具体的签名、桶和凭证仅在应用装配层处理。
type CloudObjectStorage interface {
	Put(ctx context.Context, objectKey, contentType string, content []byte, sha256 string) (storedObjectKey string, err error)
}
