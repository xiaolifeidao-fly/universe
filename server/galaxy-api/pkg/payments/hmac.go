// Package payments 是支付渠道回调的验签实现。
//
// 领域层只认 galaxy.PaymentVerifier 这一个接口 —— 支付宝的 RSA2、微信 V3 的
// SHA256-RSA、Stripe 的 HMAC 各有各的签名法，但回答的是同一个问题：
// 「这条通知真是渠道发的吗，说的是哪一单、付了多少」。
//
// 这里先给出 HMAC-SHA256 这一种。它覆盖 Stripe 式（`t=…,v1=…`）和多数自建
// 收银台的形态；接支付宝/微信时在本包里另加一个实现，装配层换个构造函数即可，
// 领域层一行不用改。
package payments

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"service/galaxy"
)

// HMACConfig 一个 HMAC 渠道的接法。
type HMACConfig struct {
	// Channel 渠道名，只用于日志与路由匹配。
	Channel string
	// Secret 与渠道共享的密钥。空则这个渠道不可用 —— 构造时就会失败，
	// 而不是在运行时静默放行。
	Secret string
	// SignatureHeader / TimestampHeader 签名与时间戳所在的请求头。
	SignatureHeader string
	TimestampHeader string
	// Tolerance 时间戳容差。签名一旦泄露，容差决定了它还能被重放多久。
	Tolerance time.Duration
}

func (c HMACConfig) withDefaults() HMACConfig {
	if c.SignatureHeader == "" {
		c.SignatureHeader = "X-Signature"
	}
	if c.TimestampHeader == "" {
		c.TimestampHeader = "X-Timestamp"
	}
	if c.Tolerance <= 0 {
		c.Tolerance = 5 * time.Minute
	}
	return c
}

// HMACVerifier 校验 `HMAC-SHA256(secret, timestamp + "." + body)`。
//
// 时间戳进签名而不是只做个旁路检查：不签的话，中间人可以把时间戳改成当前时刻，
// 让一条几个月前截获的回调重新通过时效检查。
type HMACVerifier struct {
	config HMACConfig
}

func NewHMACVerifier(config HMACConfig) (*HMACVerifier, error) {
	config = config.withDefaults()
	if strings.TrimSpace(config.Secret) == "" {
		return nil, errors.New("支付回调密钥为空，拒绝以不验签的方式启用")
	}
	return &HMACVerifier{config: config}, nil
}

// callbackBody 是渠道回调里我们认的那几个字段。
// 渠道各自的额外字段一律忽略 —— 它们不参与任何判断。
type callbackBody struct {
	OrderID    string `json:"orderId"`
	PaymentRef string `json:"paymentRef"`
	Amount     int64  `json:"amount"`
	Currency   string `json:"currency"`
	Status     string `json:"status"`
}

func (v *HMACVerifier) Verify(_ context.Context, callback galaxy.PaymentCallback) (galaxy.PaymentResult, error) {
	signature := header(callback.Headers, v.config.SignatureHeader)
	timestamp := header(callback.Headers, v.config.TimestampHeader)
	if signature == "" || timestamp == "" {
		return galaxy.PaymentResult{}, errors.New("支付回调缺少签名")
	}
	if err := v.checkFreshness(timestamp, callback.ReceivedAt); err != nil {
		return galaxy.PaymentResult{}, err
	}
	if !v.matches(timestamp, callback.Body, signature) {
		return galaxy.PaymentResult{}, errors.New("支付回调签名不正确")
	}

	var body callbackBody
	if err := json.Unmarshal(callback.Body, &body); err != nil {
		return galaxy.PaymentResult{}, errors.New("支付回调报文无法解析")
	}
	if body.OrderID == "" || body.PaymentRef == "" {
		return galaxy.PaymentResult{}, errors.New("支付回调缺少订单号或流水号")
	}
	return galaxy.PaymentResult{
		OrderID: body.OrderID, PaymentRef: body.PaymentRef,
		AmountPaid: body.Amount, Currency: body.Currency,
		Paid: strings.EqualFold(body.Status, "paid") || strings.EqualFold(body.Status, "success"),
	}, nil
}

func (v *HMACVerifier) checkFreshness(timestamp string, now time.Time) error {
	seconds, err := parseUnix(timestamp)
	if err != nil {
		return errors.New("支付回调时间戳无法解析")
	}
	if now.IsZero() {
		now = time.Now()
	}
	drift := now.Sub(time.Unix(seconds, 0))
	if drift < 0 {
		drift = -drift
	}
	if drift > v.config.Tolerance {
		return fmt.Errorf("支付回调已过期")
	}
	return nil
}

// matches 用 hmac.Equal 而不是字符串比较：等长比较必须是常数时间的，
// 否则比较耗时会把正确签名一个字节一个字节地泄露出去。
func (v *HMACVerifier) matches(timestamp string, body []byte, presented string) bool {
	mac := hmac.New(sha256.New, []byte(v.config.Secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	expected := mac.Sum(nil)

	decoded, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(presented), "sha256="))
	if err != nil {
		return false
	}
	return hmac.Equal(expected, decoded)
}

// Sign 按同一套规则算签名。给测试和自建收银台用。
func Sign(secret, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// header 大小写不敏感地取一个头。回调来自外部系统，头的大小写不由我们决定。
func header(headers map[string]string, name string) string {
	if value, ok := headers[name]; ok {
		return value
	}
	for key, value := range headers {
		if strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}

func parseUnix(value string) (int64, error) {
	var seconds int64
	if _, err := fmt.Sscanf(strings.TrimSpace(value), "%d", &seconds); err != nil {
		return 0, err
	}
	return seconds, nil
}
