package identity

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type tokenClaims struct {
	Subject      int64 `json:"sub"`
	TokenVersion int   `json:"ver"`
	ExpiresAt    int64 `json:"exp"`
}

func issueToken(secret string, subject int64, tokenVersion int, expiresAt time.Time) (string, error) {
	if secret == "" {
		return "", errors.New("认证密钥未配置")
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, err := json.Marshal(tokenClaims{Subject: subject, TokenVersion: tokenVersion, ExpiresAt: expiresAt.Unix()})
	if err != nil {
		return "", err
	}
	body := header + "." + base64.RawURLEncoding.EncodeToString(payload)
	return body + "." + signToken(secret, body), nil
}

func parseToken(secret, raw string) (tokenClaims, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 || secret == "" {
		return tokenClaims{}, errors.New("无效登录凭证")
	}
	body := parts[0] + "." + parts[1]
	expected := signToken(secret, body)
	if !hmac.Equal([]byte(expected), []byte(parts[2])) {
		return tokenClaims{}, errors.New("无效登录凭证")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return tokenClaims{}, errors.New("无效登录凭证")
	}
	var claims tokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Subject <= 0 || claims.ExpiresAt <= time.Now().Unix() {
		return tokenClaims{}, errors.New("登录凭证已失效")
	}
	return claims, nil
}

func signToken(secret, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(body))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
