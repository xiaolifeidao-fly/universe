package galaxy

import (
	"strings"
	"testing"
)

// TestKeyCipherRoundTrip 明文加密存进去、取出来还是它；换一把加密密钥必须解不开 ——
// 解得开但解错的话，运营会把一串对不上号的明文当成密钥转交出去。
func TestKeyCipherRoundTrip(t *testing.T) {
	cipher := newKeyCipher("deploy-secret")
	sealed, err := cipher.seal("sk-galaxy-ABCDEF")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if !strings.HasPrefix(sealed, keyCipherVersion) || strings.Contains(sealed, "ABCDEF") {
		t.Fatalf("密文形状不对：%s", sealed)
	}
	plain, err := cipher.open(sealed)
	if err != nil || plain != "sk-galaxy-ABCDEF" {
		t.Fatalf("open = %q, %v", plain, err)
	}
	again, _ := cipher.seal("sk-galaxy-ABCDEF")
	if again == sealed {
		t.Fatal("同一串明文两次加密不该得到同一个密文（nonce 没有随机）")
	}
	if _, err := newKeyCipher("another-secret").open(sealed); err != errKeyCipherMismatch {
		t.Fatalf("换了加密密钥应当解不开，实际 %v", err)
	}
	if _, err := cipher.open("plain-text"); err != errKeyCipherMismatch {
		t.Fatalf("没有版本前缀的串应当拒绝，实际 %v", err)
	}
}

// TestKeyCipherMissing 没配加密密钥：签发照常（存空串），取回时明说原因。
func TestKeyCipherMissing(t *testing.T) {
	if newKeyCipher("  ") != nil {
		t.Fatal("空白的配置应当等于没配")
	}
	svc := &service{}
	if sealed := svc.sealSecret("sk-galaxy-x"); sealed != "" {
		t.Fatalf("没配加密密钥时不该存密文，实际 %q", sealed)
	}
	var missing *keyCipher
	if _, err := missing.open("v1:abc"); err != errKeyCipherMissing {
		t.Fatalf("应当报没配置，实际 %v", err)
	}
}

// TestScopeCategory「使用」按钮写 Claude Code 还是 Codex 就看它。
func TestScopeCategory(t *testing.T) {
	cases := []struct {
		name    string
		kinds   []string
		tiers   []string
		modelID string
		want    string
	}{
		{"视频能力优先", []string{"video.edit.render"}, []string{"claude-*"}, "", "video"},
		{"模型档写了 claude", nil, []string{"claude-sonnet-*"}, "gpt-5.6-terra", "claude"},
		{"模型档写了 gpt", nil, []string{"gpt-*"}, "", "codex"},
		{"模型档没写，看绑定的模型", nil, nil, "claude-opus-5", "claude"},
		{"绑定的是 gpt 一族", nil, nil, "gpt-5.6-terra", "codex"},
		{"认不出来的模型", nil, nil, "gemini-3", "other"},
		{"什么都没限", nil, nil, "", "other"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if got := scopeCategory(item.kinds, item.tiers, item.modelID); got != item.want {
				t.Fatalf("scopeCategory = %s，应为 %s", got, item.want)
			}
		})
	}
}

// TestReferralRateTable 模型单独设过的用自己的（包括显式设成 0 = 不返），没设的走默认。
func TestReferralRateTable(t *testing.T) {
	table := referralRateTable{defaultBps: 500, models: map[string]int64{"claude-opus-5": 1500, "gpt-5.6-terra": 0}}
	cases := []struct {
		modelID   string
		want      int64
		inherited bool
	}{
		{"claude-opus-5", 1500, false},
		{"gpt-5.6-terra", 0, false},
		{"claude-sonnet-5", 500, true},
		{"", 500, true},
	}
	for _, item := range cases {
		if got := table.of(item.modelID); got != item.want {
			t.Errorf("%q 的比例 = %d，应为 %d", item.modelID, got, item.want)
		}
		if got := table.inherits(item.modelID); got != item.inherited {
			t.Errorf("%q 是否走默认 = %v，应为 %v", item.modelID, got, item.inherited)
		}
	}
}

// TestInviteCode 邀请码只用好认的字符，大小写、空格、连字符都能被收回同一个码。
func TestInviteCode(t *testing.T) {
	seen := map[string]bool{}
	for index := 0; index < 200; index++ {
		code := NewInviteCode()
		if len(code) != inviteCodeLength {
			t.Fatalf("邀请码长度不对：%q", code)
		}
		for _, char := range code {
			if !strings.ContainsRune(inviteAlphabet, char) {
				t.Fatalf("邀请码里出现了字符表以外的 %q：%s", char, code)
			}
		}
		seen[code] = true
	}
	if len(seen) < 195 {
		t.Fatalf("200 个码里只有 %d 个不同，随机性不对", len(seen))
	}
	if got := NormalizeInviteCode(" ab3d-ef9h "); got != "AB3DEF9H" {
		t.Fatalf("NormalizeInviteCode = %q", got)
	}
}

func TestMaskName(t *testing.T) {
	cases := map[string]string{
		"":              "",
		"a":             "*",
		"ab":            "a*",
		"fly":           "f*y",
		"zhangsan":      "z****n",
		"13800001234":   "1****4",
		"张三丰":           "张*丰",
		"  padded  ":    "p****d",
		"x@example.com": "x****m",
	}
	for input, want := range cases {
		if got := maskName(input); got != want {
			t.Errorf("maskName(%q) = %q，应为 %q", input, got, want)
		}
	}
}
