// 从原型 tasks.json 导入的入参与结果。

package dto

import (
	"contract"
)

// ---------- 导入 ----------

// ImportRequest 直接吃原型 assets/tasks.json 的形状，
// 字段名保持原型的写法（id/desc/lv/when），这样 cmd/dlvimport 可以原样反序列化。
type ImportRequest struct {
	BizLine     contract.BizLine `json:"-"`
	ProgramID   int64            `json:"programId"`
	ProgramName string           `json:"programName"`
	Meta        ImportMeta       `json:"meta"`
	Stages      []ImportStage    `json:"stages"`
	Modules     []ImportModule   `json:"modules"`
	Tasks       []ImportTask     `json:"tasks"`
	ActorID     string           `json:"-"`
	ActorName   string           `json:"actorName"`
}

type ImportMeta struct {
	Name string `json:"name"`
}

type ImportStage struct {
	Idx   int    `json:"idx"`
	Tag   string `json:"tag"`
	When  string `json:"when"`
	Lv    string `json:"lv"`
	Title string `json:"title"`
}

type ImportModule struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Weight int    `json:"weight"`
	Kind   string `json:"kind"`
}

type ImportTask struct {
	ID       string `json:"id"`
	Module   string `json:"module"`
	Type     string `json:"type"`
	Title    string `json:"title"`
	Desc     string `json:"desc"`
	Stage    int    `json:"stage"`
	Status   string `json:"status"`
	Progress int    `json:"progress"`
	Owner    string `json:"owner"`
	Due      string `json:"due"`
	Note     string `json:"note"`
}

type ImportResult struct {
	Stages  int `json:"stages"`
	Modules int `json:"modules"`
	Created int `json:"created"`
	Updated int `json:"updated"`
}
