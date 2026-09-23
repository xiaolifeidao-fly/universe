package account

import (
	"strings"
	"testing"
)

func TestNormalizeUsername(t *testing.T) {
	accepted := map[string]string{
		"Fly":               "fly",
		"  xianglong  ":     "xianglong",
		"13800138000":       "13800138000",
		"Me+Galaxy@Mail.cn": "me+galaxy@mail.cn",
		"studio_01.gpu-a":   "studio_01.gpu-a",
	}
	for raw, want := range accepted {
		got, err := normalizeUsername(raw)
		if err != nil || got != want {
			t.Errorf("normalizeUsername(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{"", "a", "_fly", "fly fly", "飞", strings.Repeat("a", 65)} {
		if _, err := normalizeUsername(raw); err == nil {
			t.Errorf("normalizeUsername(%q) 应当被拒", raw)
		}
	}
}

func TestHashPasswordBounds(t *testing.T) {
	if _, err := hashPassword("short"); err == nil {
		t.Error("不足 8 个字符的密码应当被拒")
	}
	// bcrypt 只看前 72 个字节。放过去的话，第 73 个字节以后随便改都能登进去。
	if _, err := hashPassword(strings.Repeat("x", 73)); err == nil {
		t.Error("超过 72 个字节的密码应当被拒")
	}
	if _, err := hashPassword(strings.Repeat("x", 72)); err != nil {
		t.Errorf("72 个字节的密码应当可用：%v", err)
	}
}

func TestIDPrefixBySide(t *testing.T) {
	if idPrefix("provider") != "pu_" || idPrefix("consumer") != "cu_" || idPrefix("admin") != "" {
		t.Fatal("两端的业务键前缀变了 —— 迁移脚本和令牌校验都按这两个前缀认人")
	}
}
