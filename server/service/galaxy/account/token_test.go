package account

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"service/galaxy/dto"
)

const testSecret = "galaxy-test-secret"

func TestTokenRoundTrip(t *testing.T) {
	now := time.Now()
	token, err := issueToken(testSecret, dto.SideProvider, "pu_01TEST", 3, now.Add(time.Hour))
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	claims, err := parseToken(testSecret, dto.SideProvider, token, now)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if claims.Subject != "pu_01TEST" || claims.Version != 3 || claims.Audience != dto.SideProvider {
		t.Fatalf("claims = %+v", claims)
	}
}

// TestTokenRejectedByOtherSide 一端的令牌调不了另一端：Nova 登录拿到的令牌塞进 Orbit，
// 应该和没登录一样。
func TestTokenRejectedByOtherSide(t *testing.T) {
	now := time.Now()
	token, err := issueToken(testSecret, dto.SideConsumer, "cu_01TEST", 1, now.Add(time.Hour))
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if _, err := parseToken(testSecret, dto.SideProvider, token, now); err == nil {
		t.Fatal("使用端的令牌不该通过共享端的校验")
	}
}

// TestTaskUniverseTokenRejected 盯住这次拆分的初衷：任务宇宙（service/identity）签的令牌，
// 就算签名密钥碰巧一样，也不能在 Galaxy 这边登进去。
//
// 这里手搓一张 identity 形状的令牌（数字 sub、没有 iss / aud），用同一个密钥签。
func TestTaskUniverseTokenRejected(t *testing.T) {
	now := time.Now()
	payload, _ := json.Marshal(map[string]any{"sub": 4, "ver": 1, "exp": now.Add(time.Hour).Unix()})
	body := tokenHeader + "." + base64.RawURLEncoding.EncodeToString(payload)
	identityToken := body + "." + signToken(testSecret, body)

	for _, side := range []string{dto.SideProvider, dto.SideConsumer} {
		if _, err := parseToken(testSecret, side, identityToken, now); err == nil {
			t.Fatalf("任务宇宙的令牌通过了 %s 端的校验", side)
		}
	}
}

// TestTokenSubjectMustMatchSide aud 和 sub 前缀要对得上。签发只会签出对得上的，
// 对不上说明令牌是拼出来的。
func TestTokenSubjectMustMatchSide(t *testing.T) {
	now := time.Now()
	token, err := issueToken(testSecret, dto.SideProvider, "cu_01TEST", 1, now.Add(time.Hour))
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if _, err := parseToken(testSecret, dto.SideProvider, token, now); err == nil {
		t.Fatal("sub 是使用端的 id，却声称自己是共享端的令牌")
	}
}

func TestTokenExpiredAndTampered(t *testing.T) {
	now := time.Now()
	expired, _ := issueToken(testSecret, dto.SideProvider, "pu_01TEST", 1, now.Add(-time.Second))
	if _, err := parseToken(testSecret, dto.SideProvider, expired, now); err != errTokenExpired {
		t.Fatalf("过期令牌 err = %v", err)
	}

	valid, _ := issueToken(testSecret, dto.SideProvider, "pu_01TEST", 1, now.Add(time.Hour))
	if _, err := parseToken("another-secret", dto.SideProvider, valid, now); err == nil {
		t.Fatal("换一个密钥还能验过")
	}
	parts := strings.Split(valid, ".")
	forged, _ := json.Marshal(tokenClaims{Issuer: tokenIssuer, Audience: dto.SideProvider, Subject: "pu_SOMEONE_ELSE", Version: 1, ExpiresAt: now.Add(time.Hour).Unix()})
	tampered := parts[0] + "." + base64.RawURLEncoding.EncodeToString(forged) + "." + parts[2]
	if _, err := parseToken(testSecret, dto.SideProvider, tampered, now); err == nil {
		t.Fatal("改了 payload 签名还能验过")
	}
}

func TestTokenNeedsSecret(t *testing.T) {
	if _, err := issueToken("", dto.SideProvider, "pu_01TEST", 1, time.Now().Add(time.Hour)); err != errTokenSecretMissing {
		t.Fatalf("没配密钥 err = %v", err)
	}
}
