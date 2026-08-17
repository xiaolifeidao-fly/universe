package bizline

import (
	"context"

	"contract"
)

// ProgramCounter 是业务线删除时所需的最小 delivery 域读取能力。
// 业务线本身不直接读取 zt_delivery_*，避免跨域穿透持久化层。
type ProgramCounter interface {
	CountPrograms(ctx context.Context, bizLine contract.BizLine) (int64, error)
}
