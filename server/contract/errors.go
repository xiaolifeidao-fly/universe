package contract

import "errors"

// 哨兵错误。这些文案会经 httpx.JSON 直接显示给用户，写成人能看懂的中文短句，
// 不要暴露 SQL 或内部字段名。
var (
	ErrBizLineRequired = errors.New("缺少空间")
	ErrNotFound        = errors.New("记录不存在")

	// ErrVersionConflict 乐观锁冲突：读到的版本已经被别人改过。
	// 看板是多人同时开着的，整份覆盖写必然互相吃掉对方的改动，
	// 所以单条更新一律带 version，冲突时让前端提示重新加载。
	ErrVersionConflict = errors.New("这条任务已被他人修改，请刷新后重试")
)
