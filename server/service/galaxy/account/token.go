package account

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// 令牌是 HS256 签名的 JWT，服务端不存会话：账号还有没有效，每次请求按 sub 查一次库，
// 拿库里的 token_version 和令牌里的比。改密码、重置、停用都让版本加一，旧令牌当场失效。
//
// 和任务宇宙的令牌故意长得不一样，靠的不是密钥：
//
//	iss  固定 galaxy
//	aud  provider / consumer —— 一端的令牌调不了另一端
//	sub  字符串业务键（pu_… / cu_…）—— 任务宇宙的 sub 是数字，按字符串解析直接失败
//
// 所以就算部署时两边的签名密钥配成了同一个，令牌也不会串用。

const tokenIssuer = "galaxy"

var (
	errTokenSecretMissing = errors.New("认证密钥未配置")
	errTokenInvalid       = errors.New("无效登录凭证")
	errTokenExpired       = errors.New("登录凭证已失效")
)

type tokenClaims struct {
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	Subject   string `json:"sub"`
	Version   int    `json:"ver"`
	ExpiresAt int64  `json:"exp"`
}

var tokenHeader = base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))

func issueToken(secret, side, subject string, version int, expiresAt time.Time) (string, error) {
	if secret == "" {
		return "", errTokenSecretMissing
	}
	payload, err := json.Marshal(tokenClaims{
		Issuer: tokenIssuer, Audience: side, Subject: subject, Version: version, ExpiresAt: expiresAt.Unix(),
	})
	if err != nil {
		return "", err
	}
	body := tokenHeader + "." + base64.RawURLEncoding.EncodeToString(payload)
	return body + "." + signToken(secret, body), nil
}

// parseToken 验签、验形状、验过期，再验是不是这一端的。库里的状态由调用方接着查。
func parseToken(secret, side, raw string, now time.Time) (tokenClaims, error) {
	if secret == "" {
		return tokenClaims{}, errTokenSecretMissing
	}
	parts := strings.Split(strings.TrimSpace(raw), ".")
	if len(parts) != 3 {
		return tokenClaims{}, errTokenInvalid
	}
	body := parts[0] + "." + parts[1]
	if !hmac.Equal([]byte(signToken(secret, body)), []byte(parts[2])) {
		return tokenClaims{}, errTokenInvalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return tokenClaims{}, errTokenInvalid
	}
	var claims tokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return tokenClaims{}, errTokenInvalid
	}
	if claims.Issuer != tokenIssuer || claims.Audience != side || !validSide(side) ||
		!strings.HasPrefix(claims.Subject, idPrefix(side)) {
		return tokenClaims{}, errTokenInvalid
	}
	if claims.ExpiresAt <= now.Unix() {
		return tokenClaims{}, errTokenExpired
	}
	return claims, nil
}

func signToken(secret, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(body))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
