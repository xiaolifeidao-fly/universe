// 项目相关的请求与视图。

package dto

import (
	"time"

	"contract"
)

// ---------- 项目 ----------

type ProgramView struct {
	ProgramID          int64            `json:"programId"`
	ProgramCode        string           `json:"programCode"`
	BizLine            contract.BizLine `json:"bizLine"`
	Name               string           `json:"name"`
	Summary            string           `json:"summary"`
	Status             string           `json:"status"`
	GitEnabled         bool             `json:"gitEnabled"`
	GitRepositoryURL   string           `json:"gitRepositoryUrl"`
	GitRemoteName      string           `json:"gitRemoteName"`
	GitBaseBranch      string           `json:"gitBaseBranch"`
	GitChatSyncEnabled bool             `json:"gitChatSyncEnabled"`
	// 云端同步配置由项目管理员维护；正文由本机桥接按类别上传到项目云端文件库。
	CloudSyncEnabled bool       `json:"cloudSyncEnabled"`
	CloudSyncScopes  []string   `json:"cloudSyncScopes"`
	UpdatedBy        string     `json:"updatedBy"`
	UpdatedAt        *time.Time `json:"updatedAt"`

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
	GitEnabled       bool             `json:"gitEnabled"`
	GitRepositoryURL string           `json:"gitRepositoryUrl"`
	GitRemoteName    string           `json:"gitRemoteName"`
	GitBaseBranch    string           `json:"gitBaseBranch"`
	// GitChatSyncEnabled 开启后，本机桥接会将已结束的聊天写入工作目录 chat/。
	// Git 未启用时服务端会强制关闭，避免产生无法随项目提交的本地副本。
	GitChatSyncEnabled bool   `json:"gitChatSyncEnabled"`
	ActorID            string `json:"-"`
	ActorName          string `json:"actorName"`
}

// SaveProgramCloudSyncConfigRequest 只更新项目级云端同步策略；本机工作目录仍只保存在用户浏览器中。
type SaveProgramCloudSyncConfigRequest struct {
	BizLine          contract.BizLine `json:"-"`
	ProgramID        int64            `json:"programId"`
	CloudSyncEnabled bool             `json:"cloudSyncEnabled"`
	CloudSyncScopes  []string         `json:"cloudSyncScopes"`
	ActorID          string           `json:"-"`
	ActorName        string           `json:"actorName"`
}

// UpsertCloudSyncFileRequest 是本机桥接向项目云端文件库写入一个已选择类别的文件。
// Content 不从浏览器绑定，Handler 解码 contentBase64 后再交给 Service。
type UpsertCloudSyncFileRequest struct {
	BizLine      contract.BizLine `json:"-"`
	ProgramID    int64            `json:"programId"`
	Category     string           `json:"category"`
	RelativePath string           `json:"relativePath"`
	ContentType  string           `json:"contentType"`
	Content      []byte           `json:"-"`
	ActorID      string           `json:"-"`
	ActorName    string           `json:"actorName"`
}

type CloudSyncFileView struct {
	ProgramID    int64      `json:"programId"`
	Category     string     `json:"category"`
	RelativePath string     `json:"relativePath"`
	ContentType  string     `json:"contentType"`
	Size         int64      `json:"size"`
	SHA256       string     `json:"sha256"`
	UpdatedAt    *time.Time `json:"updatedAt"`
	ObjectKey    string     `json:"-"`
}

// CloudSyncFileQuery lists only metadata for a project's enabled cloud file
// categories. Object keys never leave the application boundary.
type CloudSyncFileQuery struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId" form:"programId"`
	Category  string           `json:"category" form:"category"`
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
