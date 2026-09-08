package galaxy

import (
	"context"
	"errors"
	"testing"
)

// fakeDirectory 一个只会报渠道清单的验签器。Verify 永远拒绝 ——
// 这些用例问的是「渠道表怎么读」，一旦有人在这里真的走进验签就是跑错路了。
type fakeDirectory struct{ channels []PaymentChannel }

func (fakeDirectory) Verify(context.Context, PaymentCallback) (PaymentResult, error) {
	return PaymentResult{}, errors.New("这些用例不该走到验签")
}

func (f fakeDirectory) Channels() []PaymentChannel { return f.channels }

// verifierOnly 不实现 PaymentDirectory：第三方验签器说不出自己有哪些渠道。
type verifierOnly struct{}

func (verifierOnly) Verify(context.Context, PaymentCallback) (PaymentResult, error) {
	return PaymentResult{}, nil
}

// TestPaymentEnabledIgnoresSandboxOnlyDeployments 只配了沙箱的部署不该挂上
// 未鉴权的回调路由 —— 沙箱渠道压根不接受外部回调，为它开一个公网入口是白开。
func TestPaymentEnabledIgnoresSandboxOnlyDeployments(t *testing.T) {
	cases := []struct {
		name    string
		payment PaymentVerifier
		want    bool
	}{
		{"没接支付", nil, false},
		{"只有沙箱渠道", fakeDirectory{[]PaymentChannel{{Code: "sandbox", Sandbox: true}}}, false},
		{"有一个已验签渠道", fakeDirectory{[]PaymentChannel{{Code: "wechat"}}}, true},
		{"沙箱与真渠道并存", fakeDirectory{[]PaymentChannel{
			{Code: "sandbox", Sandbox: true}, {Code: "wechat"},
		}}, true},
		{"说不出渠道清单的验签器按已接入处理", verifierOnly{}, true},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			svc := &service{payment: item.payment}
			if got := svc.PaymentEnabled(); got != item.want {
				t.Fatalf("PaymentEnabled 应为 %v，实际 %v", item.want, got)
			}
		})
	}
}

// TestResolveSandboxChannel 盯的是「渠道码不能由调用方随便写」：
// 它会原样进支付流水号，放任下去等于让请求方往账目里写字；
// 更要紧的是，把一个真渠道的码传进沙箱支付必须失败，
// 否则账上会出现一条「微信付过了」而微信那边根本没这笔钱。
func TestResolveSandboxChannel(t *testing.T) {
	channels := []PaymentChannel{
		{Code: "alipay_sandbox", Sandbox: true},
		{Code: "wechat", Sandbox: false},
		{Code: "wechat_sandbox", Sandbox: true},
	}
	svc := &service{payment: fakeDirectory{channels}}

	cases := []struct {
		name      string
		requested string
		want      string
		wantErr   bool
	}{
		{"指定一个沙箱渠道", "wechat_sandbox", "wechat_sandbox", false},
		{"大小写与空白不敏感", "  WeChat_Sandbox ", "wechat_sandbox", false},
		{"不指定就取第一个沙箱渠道", "", "alipay_sandbox", false},
		{"真渠道不能走沙箱支付", "wechat", "", true},
		{"没接过的渠道码一律拒", "stripe", "", true},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			got, err := svc.resolveSandboxChannel(item.requested)
			if item.wantErr {
				if err == nil {
					t.Fatalf("应当报错，实际得到 %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("不该报错：%v", err)
			}
			if got != item.want {
				t.Fatalf("应为 %q，实际 %q", item.want, got)
			}
		})
	}
}

// TestResolveSandboxChannelWithoutSandbox 没配沙箱的部署调沙箱支付必须失败 ——
// 这条是「点一下就发额度」这件事不会漏到生产的最后一道闸。
func TestResolveSandboxChannelWithoutSandbox(t *testing.T) {
	svc := &service{payment: fakeDirectory{[]PaymentChannel{{Code: "wechat"}}}}
	if _, err := svc.resolveSandboxChannel(""); err == nil {
		t.Fatal("没配沙箱渠道时必须拒绝沙箱支付")
	}
	bare := &service{}
	if _, err := bare.resolveSandboxChannel("anything"); err == nil {
		t.Fatal("没接支付时必须拒绝沙箱支付")
	}
}
