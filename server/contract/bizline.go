// Package contract 是唯一的跨领域数据形状，零依赖。
//
// 判断标准：这个类型被两个以上的层看见吗？是 → 放这里；只有本层用 → 放
// service/{domain}/dto。
package contract

// BizLine 业务线编码，如 whatsapp / tiktok。
//
// 它是横切维度而不是纵向服务：每张表都带 biz_line，所有索引以它打头。
type BizLine string

// Valid 目前只要求非空。将来接了业务线注册表之后，这里也不做远程校验 ——
// 校验发生在 service/bizline，contract 必须保持零依赖。
func (b BizLine) Valid() bool { return b != "" }

func (b BizLine) String() string { return string(b) }
