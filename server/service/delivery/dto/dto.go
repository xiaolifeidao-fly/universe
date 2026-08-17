// Package dto 是 delivery 层的数据形状。
//
// 这里刻意不用 `binding:"required"`：gin 的 validator 报的是
// `Key: 'RebuildSnapshotRequest.ProgramID' Error:Field validation for 'ProgramID'
// failed on the 'required' tag`，而 httpx.Fail 会把这串东西原样弹给用户。
// 必填校验统一放在 service 里，返回「缺少项目标识」这种人能看懂的中文短句 ——
// 每个字段在对应的 Service 方法开头都有一遍。
package dto

type Page struct {
	PageIndex int `json:"pageIndex" form:"pageIndex"`
	PageSize  int `json:"pageSize" form:"pageSize"`
}

// Offset 页码从 1 起；给 0 或负数时回落到第一页，避免负偏移打穿查询。
func (p Page) Offset() int {
	if p.PageIndex <= 1 {
		return 0
	}
	return (p.PageIndex - 1) * p.Limit()
}

func (p Page) Limit() int {
	if p.PageSize <= 0 {
		return 20
	}
	if p.PageSize > 200 {
		return 200
	}
	return p.PageSize
}
