// 项目相关的请求与视图。

package dto

import (
	"time"

	"contract"
)

// ---------- 项目 ----------

type ProgramView struct {
	ProgramID        int64            `json:"programId"`
	ProgramCode      string           `json:"programCode"`
	BizLine          contract.BizLine `json:"bizLine"`
	Name             string           `json:"name"`
	Summary          string           `json:"summary"`
	Status           string           `json:"status"`
	GitRepositoryURL string           `json:"gitRepositoryUrl"`
	GitRemoteName    string           `json:"gitRemoteName"`
	GitBaseBranch    string           `json:"gitBaseBranch"`
	UpdatedBy        string           `json:"updatedBy"`
	UpdatedAt        *time.Time       `json:"updatedAt"`

	// CanAdminister / CanWrite 是「当前调用者对这个项目的权限」，由 API 层按调用者身份填充。
	// 前端据此决定按钮的显隐 —— 权限判定只有服务端说了算。
	CanAdminister bool `json:"canAdminister"`
	CanWrite      bool `json:"canWrite"`
}

type SaveProgramRequest struct {
	BizLine     contract.BizLine `json:"-"`
	ProgramID   int64            `json:"programId"`
	ProgramCode string           `json:"programCode"`
	Name        string           `json:"name"`
	Summary     string           `json:"summary"`
	Status      string           `json:"status"`
	ActorID     string           `json:"-"`
	ActorName   string           `json:"actorName"`
}

// SaveProgramGitConfigRequest 只更新项目共享的 Git 校验策略；本机工作目录不落库。
// GitRepositoryURL 为空时允许任何本机远端，GitRemoteName 为空时回落为 origin。
type SaveProgramGitConfigRequest struct {
	BizLine          contract.BizLine `json:"-"`
	ProgramID        int64            `json:"programId"`
	GitRepositoryURL string           `json:"gitRepositoryUrl"`
	GitRemoteName    string           `json:"gitRemoteName"`
	GitBaseBranch    string           `json:"gitBaseBranch"`
	ActorID          string           `json:"-"`
	ActorName        string           `json:"actorName"`
}

// MigrateProgramRequest 把一个项目及其交付数据完整迁移到目标业务线。
// SourceBizLine 由 HTTP 上下文确定，不能信任浏览器提交的源业务线。
type MigrateProgramRequest struct {
	SourceBizLine contract.BizLine `json:"-"`
	TargetBizLine contract.BizLine `json:"targetBizLine"`
	ProgramID     int64            `json:"programId"`
	Name          string           `json:"name"`
	Summary       string           `json:"summary"`
	Status        string           `json:"status"`
	ActorID       string           `json:"-"`
	ActorName     string           `json:"actorName"`
}
