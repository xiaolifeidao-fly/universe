package payments

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"service/galaxy"
)

// Registry 按渠道码把回调分发给对应的验签器。
//
// 领域层只认一个 galaxy.PaymentVerifier；「这套部署接了几个渠道」是装配层的事。
// 路由里的 {channel} 那一段在这里第一次真正被用上 —— 在此之前它只是个日志字段，
// 于是无论打到哪个渠道路径上，验的都是同一把密钥。
//
// 分发按渠道码精确匹配，不做任何回退：找不到就拒。回退到「默认渠道」意味着
// 拿 A 渠道的密钥去验 B 渠道的通知，一旦哪天 A 的密钥泄露，B 也跟着失守。
type Registry struct {
	byCode   map[string]galaxy.PaymentVerifier
	channels []galaxy.PaymentChannel
}

// Channel 注册一个渠道。Verifier 为 nil 表示这是沙箱渠道 —— 它不接收外部回调，
// 支付由本人在控制台点出来（见 galaxy.Service.PaySandbox）。
type Channel struct {
	Code     string
	Title    string
	Sandbox  bool
	Verifier galaxy.PaymentVerifier
}

// NewRegistry 组装渠道表。
//
// 一个渠道都没有时返回 nil：调用方据此把整条回调路由关掉，
// 而不是留一个「注册了但谁也验不过」的入口在公网上。
func NewRegistry(channels []Channel) (*Registry, error) {
	registry := &Registry{byCode: map[string]galaxy.PaymentVerifier{}}
	for _, channel := range channels {
		code := normalizeChannel(channel.Code)
		if code == "" {
			return nil, fmt.Errorf("支付渠道缺少渠道码")
		}
		if _, exists := registry.byCode[code]; exists {
			return nil, fmt.Errorf("支付渠道 %s 重复注册", code)
		}
		// 非沙箱渠道必须有验签器。少配一个就静默放行，等于给这个渠道码开后门。
		if !channel.Sandbox && channel.Verifier == nil {
			return nil, fmt.Errorf("支付渠道 %s 没有验签器", code)
		}
		registry.byCode[code] = channel.Verifier
		title := strings.TrimSpace(channel.Title)
		if title == "" {
			title = code
		}
		registry.channels = append(registry.channels, galaxy.PaymentChannel{
			Code: code, Title: title, Sandbox: channel.Sandbox,
		})
	}
	if len(registry.channels) == 0 {
		return nil, nil
	}
	// 渠道码定序，界面上的顺序才不会每次重启都换一遍。
	sort.SliceStable(registry.channels, func(i, j int) bool {
		return registry.channels[i].Code < registry.channels[j].Code
	})
	return registry, nil
}

// Channels 满足 galaxy.PaymentDirectory。
func (r *Registry) Channels() []galaxy.PaymentChannel {
	out := make([]galaxy.PaymentChannel, len(r.channels))
	copy(out, r.channels)
	return out
}

// Verify 满足 galaxy.PaymentVerifier。
func (r *Registry) Verify(ctx context.Context, callback galaxy.PaymentCallback) (galaxy.PaymentResult, error) {
	code := normalizeChannel(callback.Channel)
	verifier, known := r.byCode[code]
	if !known {
		// 不回显渠道码之外的任何东西：这是个未鉴权入口，错误信息也是情报。
		return galaxy.PaymentResult{}, fmt.Errorf("未接入的支付渠道")
	}
	if verifier == nil {
		// 沙箱渠道的验签器就是 nil。它必须在这里被挡住 ——
		// 一个「点一下就算付了」的渠道要是能从公网 POST 进来，
		// 任何人都能凭一个订单号把额度提走。
		return galaxy.PaymentResult{}, fmt.Errorf("沙箱渠道不接受外部回调")
	}
	result, err := verifier.Verify(ctx, callback)
	if err != nil {
		return galaxy.PaymentResult{}, err
	}
	return result, nil
}

// normalizeChannel 渠道码大小写与空白不敏感：路径那一段由渠道自己填在回调地址里，
// 大小写不由我们决定。
func normalizeChannel(code string) string {
	return strings.ToLower(strings.TrimSpace(code))
}
