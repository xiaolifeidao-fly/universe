package routers

import "errors"

var errNoAdapters = errors.New("galaxy.adapters 没有启用任何适配器，Hub 无事可做")
