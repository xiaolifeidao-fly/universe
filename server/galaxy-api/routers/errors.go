package routers

import "errors"

var (
	errMissingRedis = errors.New("galaxy-api 需要 redis.addr：控制面缺席就无法保证座位与额度的原子性")
	errNoAdapters   = errors.New("galaxy.adapters 没有启用任何适配器，Hub 无事可做")
)
