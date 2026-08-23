// Package objectstore 提供服务端调用阿里云 OSS 的最小 PUT 适配器。
//
// 它使用 OSS V1 签名，避免让领域服务依赖某一版 SDK；桶保持私有，下载授权应另行签发。
package objectstore

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

// OSSConfig 来自服务端部署配置。Endpoint 必须是不带 bucket 的 OSS 服务端点，
// 例如 https://oss-cn-hangzhou.aliyuncs.com。
type OSSConfig struct {
	Endpoint        string
	Bucket          string
	AccessKeyID     string
	AccessKeySecret string
	Prefix          string
	PathStyle       bool
	HTTPClient      *http.Client
	Now             func() time.Time
}

// AliyunOSS 是 OSS V1 的私有桶写入客户端。
type AliyunOSS struct {
	endpoint        *url.URL
	bucket          string
	accessKeyID     string
	accessKeySecret string
	prefix          string
	pathStyle       bool
	httpClient      *http.Client
	now             func() time.Time
}

// NewAliyunOSS 校验配置并构造一个用于服务端同步的 OSS 客户端。
func NewAliyunOSS(config OSSConfig) (*AliyunOSS, error) {
	endpointText := strings.TrimSpace(config.Endpoint)
	if endpointText == "" {
		return nil, errors.New("OSS endpoint 未配置")
	}
	endpoint, err := url.Parse(endpointText)
	if err != nil || endpoint.Scheme == "" || endpoint.Host == "" || (endpoint.Scheme != "https" && endpoint.Scheme != "http") {
		return nil, errors.New("OSS endpoint 无效")
	}
	if endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, errors.New("OSS endpoint 不能包含查询参数或片段")
	}
	bucket := strings.TrimSpace(config.Bucket)
	if bucket == "" || strings.ContainsAny(bucket, "/\\?#:@") {
		return nil, errors.New("OSS bucket 无效")
	}
	if strings.TrimSpace(config.AccessKeyID) == "" || strings.TrimSpace(config.AccessKeySecret) == "" {
		return nil, errors.New("OSS 访问凭证未配置")
	}
	prefix, err := normalizeObjectKey(config.Prefix, true)
	if err != nil {
		return nil, fmt.Errorf("OSS prefix 无效: %w", err)
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return &AliyunOSS{
		endpoint: endpoint, bucket: bucket, accessKeyID: strings.TrimSpace(config.AccessKeyID),
		accessKeySecret: strings.TrimSpace(config.AccessKeySecret), prefix: prefix, pathStyle: config.PathStyle,
		httpClient: client, now: now,
	}, nil
}

// Put 将正文写入 OSS；返回的 key 已包含部署配置的 prefix，供数据库仅保存元数据时定位对象。
func (c *AliyunOSS) Put(ctx context.Context, objectKey, contentType string, content []byte, sha256 string) (string, error) {
	key, err := normalizeObjectKey(objectKey, false)
	if err != nil {
		return "", fmt.Errorf("OSS 对象键无效: %w", err)
	}
	if c.prefix != "" {
		key = c.prefix + "/" + key
	}
	if contentType = strings.TrimSpace(contentType); contentType == "" {
		contentType = "application/octet-stream"
	}
	if len(contentType) > 128 || strings.ContainsAny(contentType, "\r\n") {
		return "", errors.New("OSS 文件类型无效")
	}
	date := c.now().UTC().Format(http.TimeFormat)
	contentMD5Raw := md5.Sum(content)
	contentMD5 := base64.StdEncoding.EncodeToString(contentMD5Raw[:])
	canonicalHeaders := ""
	if sha256 != "" {
		canonicalHeaders = "x-oss-meta-sha256:" + strings.ToLower(strings.TrimSpace(sha256)) + "\n"
	}
	canonicalResource := "/" + c.bucket + "/" + key
	stringToSign := strings.Join([]string{"PUT", contentMD5, contentType, date}, "\n") + "\n" + canonicalHeaders + canonicalResource
	signer := hmac.New(sha1.New, []byte(c.accessKeySecret))
	_, _ = signer.Write([]byte(stringToSign))
	authorization := "OSS " + c.accessKeyID + ":" + base64.StdEncoding.EncodeToString(signer.Sum(nil))

	request, err := http.NewRequestWithContext(ctx, http.MethodPut, c.objectURL(key), bytes.NewReader(content))
	if err != nil {
		return "", fmt.Errorf("构造 OSS 上传请求失败: %w", err)
	}
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Content-MD5", contentMD5)
	request.Header.Set("Date", date)
	request.Header.Set("Authorization", authorization)
	if canonicalHeaders != "" {
		request.Header.Set("x-oss-meta-sha256", strings.ToLower(strings.TrimSpace(sha256)))
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("上传 OSS 失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return "", fmt.Errorf("OSS 上传失败: status=%d, body=%s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	return key, nil
}

func (c *AliyunOSS) objectURL(key string) string {
	result := *c.endpoint
	result.RawQuery = ""
	result.Fragment = ""
	if c.pathStyle {
		result.Path = joinURLPath(result.Path, c.bucket, key)
	} else {
		result.Host = c.bucket + "." + result.Host
		result.Path = joinURLPath(result.Path, key)
	}
	result.RawPath = ""
	return result.String()
}

func joinURLPath(base string, parts ...string) string {
	result := strings.TrimRight(base, "/")
	if result == "" {
		result = "/"
	}
	if !strings.HasPrefix(result, "/") {
		result = "/" + result
	}
	for _, part := range parts {
		if result != "/" {
			result += "/"
		}
		result += strings.Trim(part, "/")
	}
	return result
}

func normalizeObjectKey(raw string, allowEmpty bool) (string, error) {
	value := strings.Trim(strings.TrimSpace(strings.ReplaceAll(raw, "\\", "/")), "/")
	if value == "" {
		if allowEmpty {
			return "", nil
		}
		return "", errors.New("不能为空")
	}
	cleaned := path.Clean(value)
	if cleaned == "." || cleaned != value || strings.HasPrefix(cleaned, "../") {
		return "", errors.New("不能包含路径穿越")
	}
	return cleaned, nil
}
