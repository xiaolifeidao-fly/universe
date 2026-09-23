package objectstore

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const (
	defaultSignedURLTTL = 10 * time.Minute
	defaultTokenTTL     = 5 * time.Minute
)

// AliyunOSSDeployment is the deployment-facing OSS configuration shared by
// API composition roots. The storage client only receives the values it needs
// to communicate with OSS; the URL and token TTLs remain API concerns.
type AliyunOSSDeployment struct {
	Enabled      bool
	Storage      OSSConfig
	SignedURLTTL time.Duration
	CallbackURL  string
	TokenTTL     time.Duration
}

// LoadAliyunOSSDeployment reads the standard oss.* deployment keys. A disabled
// OSS integration does not require the remaining OSS fields to be valid.
func LoadAliyunOSSDeployment(property func(string) string) (AliyunOSSDeployment, error) {
	if property == nil {
		return AliyunOSSDeployment{}, fmt.Errorf("OSS 配置读取器未提供")
	}

	enabled, err := boolProperty(property, "oss.enabled", false)
	if err != nil {
		return AliyunOSSDeployment{}, err
	}
	if !enabled {
		return AliyunOSSDeployment{}, nil
	}

	signedURLTTL, err := secondsProperty(property, "oss.expireTime", defaultSignedURLTTL)
	if err != nil {
		return AliyunOSSDeployment{}, err
	}
	tokenTTL, err := secondsProperty(property, "oss.tokenExpireTime", defaultTokenTTL)
	if err != nil {
		return AliyunOSSDeployment{}, err
	}

	endpoint := strings.TrimSpace(property("oss.endpoint"))
	if endpoint != "" && !strings.Contains(endpoint, "://") {
		endpoint = "https://" + endpoint
	}
	// oss.publicHost 是可选的：交到浏览器/客户端手里的地址走它，服务端自己的读写仍走
	// endpoint。不配就回落到 endpoint（在 NewAliyunOSS 里回落，这里保持空串原样）。
	publicHost := strings.TrimSpace(property("oss.publicHost"))
	if publicHost != "" && !strings.Contains(publicHost, "://") {
		publicHost = "https://" + publicHost
	}
	return AliyunOSSDeployment{
		Enabled: enabled,
		Storage: OSSConfig{
			Endpoint:        endpoint,
			PublicHost:      publicHost,
			Bucket:          strings.TrimSpace(property("oss.bucketName")),
			AccessKeyID:     strings.TrimSpace(property("oss.accessKeyId")),
			AccessKeySecret: strings.TrimSpace(property("oss.accessKeySecret")),
			Prefix:          strings.TrimSpace(property("oss.dirPrefix")),
		},
		SignedURLTTL: signedURLTTL,
		CallbackURL:  strings.TrimSpace(property("oss.callbackUrl")),
		TokenTTL:     tokenTTL,
	}, nil
}

// NewClient constructs the private-bucket client only when OSS is enabled.
func (config AliyunOSSDeployment) NewClient() (*AliyunOSS, error) {
	if !config.Enabled {
		return nil, nil
	}
	return NewAliyunOSS(config.Storage)
}

func boolProperty(property func(string) string, key string, fallback bool) (bool, error) {
	value := strings.TrimSpace(property(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s 必须为 true 或 false: %w", key, err)
	}
	return parsed, nil
}

func secondsProperty(property func(string) string, key string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(property(key))
	if value == "" {
		return fallback, nil
	}
	seconds, err := strconv.ParseInt(value, 10, 64)
	if err != nil || seconds <= 0 {
		if err == nil {
			err = fmt.Errorf("必须大于 0")
		}
		return 0, fmt.Errorf("%s 必须为正整数秒: %w", key, err)
	}
	return time.Duration(seconds) * time.Second, nil
}

// PublicPrefixURL 公开读目录的前缀地址：`<publicHost 或 endpoint>/<dirPrefix>`。
//
// **不需要访问凭证**：公开读的地址本来就不签名。桌面壳取更新清单就是这种地址，
// 所以一个只需要把更新地址报出去的部署可以让 oss.accessKey* 留空 —— 那种部署
// 不签任何地址、也不写对象，凭证对它没有意义，不该为此拦住更新。
//
// 它和发版页写清单用的是同一份 oss.*，因此天然对得上：清单写到 <dirPrefix>/<端>/，
// 客户端就去 <这个前缀>/<端>/ 取。让界面那一侧另配一个地址就会有第二份真相，
// 而两份不一致的症状是客户端 404 —— 表现为「安静地不更新」，没有人会收到告警。
func (config AliyunOSSDeployment) PublicPrefixURL() (string, error) {
	if !config.Enabled {
		return "", nil
	}
	host := config.Storage.PublicHost
	name := "publicHost"
	if strings.TrimSpace(host) == "" {
		host, name = config.Storage.Endpoint, "endpoint"
	}
	base, err := parseEndpoint(host, name)
	if err != nil {
		return "", err
	}
	bucket := strings.TrimSpace(config.Storage.Bucket)
	if bucket == "" || strings.ContainsAny(bucket, "/\\?#:@") {
		return "", errors.New("OSS bucket 无效")
	}
	prefix, err := normalizeObjectKey(config.Storage.Prefix, true)
	if err != nil {
		return "", fmt.Errorf("OSS prefix 无效: %w", err)
	}
	return buildObjectURL(base, bucket, config.Storage.PathStyle, prefix), nil
}
