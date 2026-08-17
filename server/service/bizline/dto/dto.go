package dto

type BizLineView struct {
	Code    string `json:"code"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

type Capability struct {
	Key             string `json:"key"`
	MinAgentVersion string `json:"minAgentVersion"`
	Enabled         bool   `json:"enabled"`
}

type RegisterRequest struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

// SaveBizLineRequest 创建或更新一条业务线。编码是其他业务表使用的归属键，
// 控制台编辑时会保持不可变；这里保留 upsert 语义以覆盖创建和状态、名称更新。
type SaveBizLineRequest struct {
	Code    string `json:"code"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

type DeleteBizLineRequest struct {
	Code string `json:"code"`
}

type SaveCapabilityRequest struct {
	BizLine         string `json:"bizLine"`
	Key             string `json:"key"`
	MinAgentVersion string `json:"minAgentVersion"`
	Enabled         bool   `json:"enabled"`
}
