package local

import (
	"context"

	"contract"
	"service/identity"
)

// NoProgramScope 让 galaxy-api 能复用控制台身份体系，而不必 import service/delivery。
//
// identity 只在「分配项目权限」这条路径上用得到项目归属，共享池控制台没有这条路径：
// 它管的是节点、贡献与密钥。这里返回 ErrNotFound 是诚实的答案 ——
// 这个进程确实不知道项目在哪，而不是假装知道。
type NoProgramScope struct{}

func (NoProgramScope) ResolveProgramBizLine(context.Context, int64) (contract.BizLine, error) {
	return "", contract.ErrNotFound
}

var _ identity.ProgramScopeReader = NoProgramScope{}
