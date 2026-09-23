package galaxy

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"strings"
	"time"
)

// ULID：48 位毫秒时间戳 + 80 位随机。按字典序即按时间序，方便按 id 翻页与排障。
// 不引第三方依赖 —— 这段逻辑二十行就够，加一个 module 不划算。
var crockford = base32.NewEncoding("0123456789ABCDEFGHJKMNPQRSTVWXYZ").WithPadding(base32.NoPadding)

func NewULID(now time.Time) string {
	var raw [16]byte
	millis := uint64(now.UTC().UnixMilli())
	var stamp [8]byte
	binary.BigEndian.PutUint64(stamp[:], millis)
	copy(raw[0:6], stamp[2:8])
	if _, err := rand.Read(raw[6:]); err != nil {
		// crypto/rand 失败在这个平台上意味着系统熵源坏了，退回时间戳填充比 panic 更可用。
		binary.BigEndian.PutUint64(raw[8:], millis)
	}
	return crockford.EncodeToString(raw[:])
}

// randomToken 生成 n 字节随机并按 crockford base32 编码，用于配对码与密钥。
func randomToken(n int) string {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		binary.BigEndian.PutUint64(raw, uint64(time.Now().UnixNano()))
	}
	return crockford.EncodeToString(raw)
}

// pairingCode 形如 8F3K-2Q9M：短、可口述、一次性。
func pairingCode() string {
	value := randomToken(5)[:8]
	return value[:4] + "-" + value[4:]
}

// HashSecret 是所有密钥落盘前的唯一形态：sha256 十六进制。明文永不入库、不入日志。
func HashSecret(secret string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(secret)))
	return hex.EncodeToString(sum[:])
}
