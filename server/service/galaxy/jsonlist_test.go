package galaxy

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"testing"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// noContribution 一个只回答 GetContribution 的控制面桩：这条测试问的是
// 「view 怎么建出来的」，和 Redis 里有什么无关。嵌一个 nil 接口而不是把
// 三十个方法抄一遍 —— 真被调到就是空指针崩，那正是我们想要的信号。
type noContribution struct{ ControlPlane }

func (noContribution) GetContribution(context.Context, string) (ContributionSnapshot, bool, error) {
	return ContributionSnapshot{}, false, nil
}

// nilList 找出「JSON 里某个键的值是 null」的那些键。
var nilList = regexp.MustCompile(`"([A-Za-z]+)":null`)

// TestListFieldsNeverSerializeToNull 钉住一条对前端的契约：**列一律是数组，不是 null**。
//
// Go 的 nil 切片序列化出去是 null。控制台用 class-transformer 建实例，
// 拿到 null 会把类字段的默认 [] 覆盖掉 —— 下一行 .map() 就是
// 「TypeError: Cannot read properties of null」。
//
// 这不是理论问题：刚配对完、还没 hello 的机器贡献列表就是空的，而那恰好是
// 每个新提供者看到的第一屏。ProviderOverview 因此白屏过一次。
//
// 用「构造一个全空的 view 再序列化」来测，而不是去调 service ——
// 后者要数据库和 Redis，而这条不变量跟数据无关，只跟结构体怎么建有关。
func TestListFieldsNeverSerializeToNull(t *testing.T) {
	// 关键的那一条走**生产代码**：contributionView 就是 ListNodes / AdminNodes
	// 逐条建 view 的地方。手搓一个 dto.ContributionView{} 只能证明「不初始化会是 null」，
	// 证明不了生产代码初始化了 —— 而后者才是这条测试要防的回归。
	svc := &service{control: noContribution{}, config: DefaultConfig()}
	bare := svc.contributionView(context.Background(), &repository.GalaxyContribution{
		CID: "n_1:claude", NodeID: "n_1", Kind: "llm.chat", Provider: "claude_oauth",
	}, nil, time.Now(), 1)

	cases := []struct {
		name  string
		value any
	}{
		{"没有额度、没有时段、不限模型的贡献（生产路径）", bare},
		{"没有贡献的机器", dto.NodeView{Contributions: make([]dto.ContributionView, 0)}},
		{"没有贡献的机器（运营视图）", dto.AdminNodeView{
			NodeView: dto.NodeView{Contributions: make([]dto.ContributionView, 0)},
		}},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			raw, err := json.Marshal(item.value)
			if err != nil {
				t.Fatalf("序列化失败：%v", err)
			}
			if found := nilList.FindAllStringSubmatch(string(raw), -1); len(found) > 0 {
				keys := make([]string, 0, len(found))
				for _, match := range found {
					keys = append(keys, match[1])
				}
				t.Fatalf("这些列序列化成了 null，前端会崩：%s\n%s", strings.Join(keys, ", "), raw)
			}
		})
	}
}

// TestOrEmptyKeepsContent orEmpty 只该把 nil 换成空切片，不该动有内容的那些。
func TestOrEmptyKeepsContent(t *testing.T) {
	if got := orEmpty[string](nil); got == nil || len(got) != 0 {
		t.Fatalf("nil 应当变成空切片，实际 %#v", got)
	}
	values := []string{"a", "b"}
	got := orEmpty(values)
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("有内容的切片不该被动，实际 %#v", got)
	}
}
