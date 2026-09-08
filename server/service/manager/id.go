package manager

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/binary"
	"time"
)

// ULID：48 位毫秒时间戳 + 80 位随机。按字典序即按时间序，方便按 id 翻页与排障。
//
// 和 service/galaxy 里那份是同一段逻辑，各写一份而不是抽公共包：领域包之间
// 零 import 是这个仓库的硬约束，为二十行工具函数破例不值当。
var crockford = base32.NewEncoding("0123456789ABCDEFGHJKMNPQRSTVWXYZ").WithPadding(base32.NoPadding)

func newULID(now time.Time) string {
	var raw [16]byte
	millis := uint64(now.UTC().UnixMilli())
	var stamp [8]byte
	binary.BigEndian.PutUint64(stamp[:], millis)
	copy(raw[0:6], stamp[2:8])
	if _, err := rand.Read(raw[6:]); err != nil {
		// crypto/rand 失败意味着系统熵源坏了，退回时间戳填充比 panic 更可用。
		binary.BigEndian.PutUint64(raw[8:], millis)
	}
	return crockford.EncodeToString(raw[:])
}
