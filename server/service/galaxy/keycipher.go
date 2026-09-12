package galaxy

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

// 算力密钥明文的加密存储。
//
// 2026-09-12 之前库里只存 sha256，明文签发一次就再也拿不回来。之后要能取回：
// 使用端的「使用」按钮要把密钥写进本机的 Claude Code / Codex 配置，
// 运营要能随时看到密钥、连同地址一起转交给对方。
//
// 取得回就意味着服务端拿得到明文，这是需求本身的代价。能做的是别让「拿到一份库」
// 就等于拿到全部密钥：加密用的密钥只在配置里（galaxy.key_cipher_secret），不进库。
// galaxy-api 签发、manager-api 取回，两个进程必须配同一个值。
//
// 鉴权仍然只按哈希查，密文不参与请求路径 —— 解密失败最多是「取不回」，不会让密钥用不了。

const keyCipherVersion = "v1:"

var (
	errKeyCipherMissing = errors.New("服务端没有配置 galaxy.key_cipher_secret，取不回密钥明文")
	// errKeyCipherMismatch 最常见的原因是签发它的进程和取回它的进程配的加密密钥不一样。
	errKeyCipherMismatch = errors.New("密钥明文解不开：签发和取回的服务配置的 galaxy.key_cipher_secret 不一致")
)

type keyCipher struct {
	aead cipher.AEAD
}

// newKeyCipher 没配加密密钥时返回 nil：新签的密钥照常可用，只是取不回明文。
func newKeyCipher(secret string) *keyCipher {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return nil
	}
	// 配置里填什么长度都行，统一摊成 32 字节。前缀把用途钉死：
	// 哪天有人把同一个值挪去签别的东西，两边的派生结果也不会相同。
	derived := sha256.Sum256([]byte("galaxy/consumer-key/" + secret))
	block, err := aes.NewCipher(derived[:])
	if err != nil {
		return nil
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil
	}
	return &keyCipher{aead: aead}
}

// seal 返回 "v1:" + base64(nonce || 密文)。版本前缀留给以后换算法或轮换密钥。
func (c *keyCipher) seal(plain string) (string, error) {
	if c == nil {
		return "", errKeyCipherMissing
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := c.aead.Seal(nonce, nonce, []byte(plain), nil)
	return keyCipherVersion + base64.RawURLEncoding.EncodeToString(sealed), nil
}

func (c *keyCipher) open(value string) (string, error) {
	if c == nil {
		return "", errKeyCipherMissing
	}
	encoded, ok := strings.CutPrefix(value, keyCipherVersion)
	if !ok {
		return "", errKeyCipherMismatch
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) < c.aead.NonceSize() {
		return "", errKeyCipherMismatch
	}
	nonce, sealed := raw[:c.aead.NonceSize()], raw[c.aead.NonceSize():]
	plain, err := c.aead.Open(nil, nonce, sealed, nil)
	if err != nil {
		return "", errKeyCipherMismatch
	}
	return string(plain), nil
}

// sealSecret 签发时调用。没配加密密钥就存空串 —— 密钥照发，只是这把以后取不回来，
// 界面上会明说原因，而不是因为少一行配置就发不出密钥。
func (s *service) sealSecret(secret string) string {
	if s.cipher == nil {
		return ""
	}
	sealed, err := s.cipher.seal(secret)
	if err != nil {
		return ""
	}
	return sealed
}
