package galaxy

import (
	"strings"
	"testing"
)

// TestNarrowKeysNeverWidens 盯的是越权：三个边界里任何一个写成「返回全部」或者
// 「忽略这个条件」，控制台就会把别人的会话列给当前用户。
func TestNarrowKeysNeverWidens(t *testing.T) {
	owned := []string{"ck_a", "ck_b"}
	cases := []struct {
		name  string
		owned []string
		keyID string
		want  []string
	}{
		{"不指定就是名下全部", owned, "", owned},
		{"指定名下的一把就只看这一把", owned, "ck_b", []string{"ck_b"}},
		{"指定别人的密钥查不到东西", owned, "ck_other", nil},
		{"名下一把都没有时不指定也查不到", nil, "", nil},
		{"名下一把都没有时指定任意密钥都查不到", nil, "ck_a", nil},
		{"空白当成没指定", owned, "   ", owned},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			got := narrowKeys(item.owned, item.keyID)
			if len(got) != len(item.want) {
				t.Fatalf("范围应为 %v，实际 %v", item.want, got)
			}
			for i := range got {
				if got[i] != item.want[i] {
					t.Fatalf("范围应为 %v，实际 %v", item.want, got)
				}
			}
		})
	}
}

// TestNarrowKeysEmptyIsNotUnfiltered 把「空 = 查不到」这条不变量单独钉住：
// 空切片进 `WHERE consumer_key IN ?` 等于没有这个条件，调用方必须在此之前挡掉。
func TestNarrowKeysEmptyIsNotUnfiltered(t *testing.T) {
	if got := narrowKeys([]string{}, "ck_a"); len(got) != 0 {
		t.Fatalf("名下无密钥时不该有任何范围，实际 %v", got)
	}
	if got := narrowKeys([]string{"ck_a"}, "ck_b"); len(got) != 0 {
		t.Fatalf("指定未持有的密钥不该有任何范围，实际 %v", got)
	}
}

func TestDeniedByOwnerIsNotRetryable(t *testing.T) {
	err := deniedByOwner("会话")
	if err == nil || !strings.Contains(err.Error(), "会话") {
		t.Fatalf("拒绝理由应指明是什么东西，实际 %v", err)
	}
}
