package objectstore

import (
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
	return AliyunOSSDeployment{
		Enabled: enabled,
		Storage: OSSConfig{
			Endpoint:        endpoint,
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
