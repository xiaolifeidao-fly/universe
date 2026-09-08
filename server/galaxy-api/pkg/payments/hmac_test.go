package payments

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"service/galaxy"
)

const secret = "test-callback-secret"

func newVerifier(t *testing.T) *HMACVerifier {
	t.Helper()
	verifier, err := NewHMACVerifier(HMACConfig{Channel: "test", Secret: secret})
	if err != nil {
		t.Fatalf("构造验签器失败：%v", err)
	}
	return verifier
}

func signedCallback(now time.Time, body string) galaxy.PaymentCallback {
	timestamp := fmt.Sprintf("%d", now.Unix())
	return galaxy.PaymentCallback{
		Channel: "test",
		Headers: map[string]string{
			"X-Timestamp": timestamp,
			"X-Signature": Sign(secret, timestamp, []byte(body)),
		},
		Body:       []byte(body),
		ReceivedAt: now,
	}
}

const paidBody = `{"orderId":"o_1","paymentRef":"pay_1","amount":9900,"currency":"CNY","status":"paid"}`

func TestVerifyAcceptsSignedCallback(t *testing.T) {
	now := time.Now()
	result, err := newVerifier(t).Verify(context.Background(), signedCallback(now, paidBody))
	if err != nil {
		t.Fatalf("合法回调应当通过：%v", err)
	}
	if result.OrderID != "o_1" || result.PaymentRef != "pay_1" || result.AmountPaid != 9900 || !result.Paid {
		t.Fatalf("解析结果不对：%+v", result)
	}
}

// TestVerifyRejectsTamperedBody 盯的是「签名必须覆盖金额」。
// 只签订单号的话，把 amount 改成 1 分钱照样能提走一百块的货。
func TestVerifyRejectsTamperedBody(t *testing.T) {
	now := time.Now()
	callback := signedCallback(now, paidBody)
	callback.Body = []byte(strings.Replace(paidBody, `"amount":9900`, `"amount":1`, 1))
	if _, err := newVerifier(t).Verify(context.Background(), callback); err == nil {
		t.Fatal("改过金额的回调必须被拒")
	}
}

// TestVerifyRejectsReplayedTimestamp 时间戳参与签名，所以改时间戳等于毁签名。
// 这条挡的是「截获一条旧回调，把时间戳改到现在再重放」。
func TestVerifyRejectsReplayedTimestamp(t *testing.T) {
	old := time.Now().Add(-2 * time.Hour)
	callback := signedCallback(old, paidBody)
	// 攻击者把时间戳改成现在，想绕过时效检查。
	callback.Headers["X-Timestamp"] = fmt.Sprintf("%d", time.Now().Unix())
	callback.ReceivedAt = time.Now()
	if _, err := newVerifier(t).Verify(context.Background(), callback); err == nil {
		t.Fatal("时间戳被改过的回调必须被拒")
	}
	// 原样重放（时间戳没改）则败在时效上。
	stale := signedCallback(old, paidBody)
	stale.ReceivedAt = time.Now()
	if _, err := newVerifier(t).Verify(context.Background(), stale); err == nil {
		t.Fatal("过期回调必须被拒")
	}
}

func TestVerifyRejectsMissingSignature(t *testing.T) {
	now := time.Now()
	callback := signedCallback(now, paidBody)
	delete(callback.Headers, "X-Signature")
	if _, err := newVerifier(t).Verify(context.Background(), callback); err == nil {
		t.Fatal("没有签名的回调必须被拒")
	}
}

func TestVerifyReadsHeadersCaseInsensitively(t *testing.T) {
	now := time.Now()
	callback := signedCallback(now, paidBody)
	callback.Headers = map[string]string{
		"x-timestamp": callback.Headers["X-Timestamp"],
		"x-signature": callback.Headers["X-Signature"],
	}
	if _, err := newVerifier(t).Verify(context.Background(), callback); err != nil {
		t.Fatalf("头的大小写不该影响验签：%v", err)
	}
}

// TestVerifyMarksNonPaymentNotifications 关单/退款通知不是支付成功。
// 判错了就会把一条「已退款」当成到账，白发一份额度。
func TestVerifyMarksNonPaymentNotifications(t *testing.T) {
	now := time.Now()
	body := `{"orderId":"o_1","paymentRef":"pay_1","amount":9900,"currency":"CNY","status":"refunded"}`
	result, err := newVerifier(t).Verify(context.Background(), signedCallback(now, body))
	if err != nil {
		t.Fatalf("合法回调应当通过：%v", err)
	}
	if result.Paid {
		t.Fatal("退款通知不该被当成支付成功")
	}
}

// TestEmptySecretIsRefused 空密钥必须在构造时就失败。
// 让它构造成功、运行时放行，等于把发额度的权限挂在公网上。
func TestEmptySecretIsRefused(t *testing.T) {
	if _, err := NewHMACVerifier(HMACConfig{Channel: "test", Secret: "  "}); err == nil {
		t.Fatal("空密钥不该构造出一个可用的验签器")
	}
}
