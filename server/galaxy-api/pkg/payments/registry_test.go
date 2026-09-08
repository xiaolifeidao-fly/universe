package payments

import (
	"context"
	"testing"
	"time"

	"service/galaxy"
)

func hmacChannelFor(t *testing.T, code, channelSecret string) Channel {
	t.Helper()
	verifier, err := NewHMACVerifier(HMACConfig{Channel: code, Secret: channelSecret})
	if err != nil {
		t.Fatalf("构造 %s 的验签器失败：%v", code, err)
	}
	return Channel{Code: code, Title: code, Verifier: verifier}
}

func signedFor(channel, channelSecret, body string, now time.Time) galaxy.PaymentCallback {
	callback := signedCallback(now, body)
	callback.Channel = channel
	callback.Headers["X-Signature"] = Sign(channelSecret, callback.Headers["X-Timestamp"], []byte(body))
	return callback
}

// TestRegistryVerifiesWithTheChannelsOwnSecret 是这个包存在的理由。
// 分发要是回退到「第一个渠道」或者「默认渠道」，A 的密钥就会被拿去验 B 的通知 ——
// A 哪天泄露，B 跟着失守。
func TestRegistryVerifiesWithTheChannelsOwnSecret(t *testing.T) {
	registry, err := NewRegistry([]Channel{
		hmacChannelFor(t, "wechat", "secret-wechat"),
		hmacChannelFor(t, "alipay", "secret-alipay"),
	})
	if err != nil {
		t.Fatalf("组装渠道表失败：%v", err)
	}
	now := time.Now()

	result, err := registry.Verify(context.Background(), signedFor("wechat", "secret-wechat", paidBody, now))
	if err != nil {
		t.Fatalf("用本渠道密钥签的回调应当通过：%v", err)
	}
	if result.OrderID != "o_1" || !result.Paid {
		t.Fatalf("解析结果不对：%+v", result)
	}

	// 拿支付宝的密钥去签一条打给微信的通知：必须被拒。
	crossed := signedFor("wechat", "secret-alipay", paidBody, now)
	if _, err := registry.Verify(context.Background(), crossed); err == nil {
		t.Fatal("用别的渠道的密钥签出来的回调必须被拒")
	}
}

func TestRegistryRejectsUnknownChannel(t *testing.T) {
	registry, err := NewRegistry([]Channel{hmacChannelFor(t, "wechat", "secret-wechat")})
	if err != nil {
		t.Fatalf("组装渠道表失败：%v", err)
	}
	callback := signedFor("stripe", "secret-wechat", paidBody, time.Now())
	if _, err := registry.Verify(context.Background(), callback); err == nil {
		t.Fatal("没接过的渠道码必须被拒")
	}
}

// TestRegistryRejectsSandboxCallback 沙箱渠道必须进不来。
// 它「点一下就算付了」，要是能从公网 POST 进来，任何人凭一个订单号就能提走额度。
func TestRegistryRejectsSandboxCallback(t *testing.T) {
	registry, err := NewRegistry([]Channel{{Code: "sandbox", Title: "沙箱", Sandbox: true}})
	if err != nil {
		t.Fatalf("组装渠道表失败：%v", err)
	}
	callback := signedFor("sandbox", "whatever", paidBody, time.Now())
	if _, err := registry.Verify(context.Background(), callback); err == nil {
		t.Fatal("沙箱渠道不该接受外部回调")
	}
}

func TestRegistryChannelCodeIsCaseInsensitive(t *testing.T) {
	registry, err := NewRegistry([]Channel{hmacChannelFor(t, "WeChat", "secret-wechat")})
	if err != nil {
		t.Fatalf("组装渠道表失败：%v", err)
	}
	if code := registry.Channels()[0].Code; code != "wechat" {
		t.Fatalf("渠道码应当归一成小写，实际 %q", code)
	}
	callback := signedFor("WECHAT", "secret-wechat", paidBody, time.Now())
	if _, err := registry.Verify(context.Background(), callback); err != nil {
		t.Fatalf("渠道码大小写不该影响分发：%v", err)
	}
}

// TestRegistryRefusesSignedChannelWithoutVerifier 少配一个验签器不能静默放行，
// 否则这个渠道码就是个后门。
func TestRegistryRefusesSignedChannelWithoutVerifier(t *testing.T) {
	if _, err := NewRegistry([]Channel{{Code: "wechat", Title: "微信支付"}}); err == nil {
		t.Fatal("非沙箱渠道没有验签器时必须构造失败")
	}
}

func TestRegistryRefusesDuplicateAndBlankCodes(t *testing.T) {
	dup := []Channel{hmacChannelFor(t, "wechat", "a"), hmacChannelFor(t, "wechat", "b")}
	if _, err := NewRegistry(dup); err == nil {
		t.Fatal("同一个渠道码注册两次必须失败")
	}
	if _, err := NewRegistry([]Channel{{Code: "  ", Sandbox: true}}); err == nil {
		t.Fatal("空渠道码必须失败")
	}
}

// TestEmptyRegistryIsNil 一个渠道都没有时返回 nil，让调用方把回调路由整个关掉。
func TestEmptyRegistryIsNil(t *testing.T) {
	registry, err := NewRegistry(nil)
	if err != nil {
		t.Fatalf("空渠道表不该报错：%v", err)
	}
	if registry != nil {
		t.Fatal("一个渠道都没有时应当返回 nil")
	}
}

// TestChannelsIsACopy 渠道表是启动期定死的，不能让调用方顺手改掉。
func TestChannelsIsACopy(t *testing.T) {
	registry, err := NewRegistry([]Channel{hmacChannelFor(t, "wechat", "secret-wechat")})
	if err != nil {
		t.Fatalf("组装渠道表失败：%v", err)
	}
	registry.Channels()[0].Sandbox = true
	if registry.Channels()[0].Sandbox {
		t.Fatal("Channels() 返回的应当是副本")
	}
}

var _ galaxy.PaymentDirectory = (*Registry)(nil)
var _ galaxy.PaymentVerifier = (*Registry)(nil)
