package consumers

import "service/galaxy"

// 这两个桩只回答 PaymentEnabled()，其余方法一律不会被路由注册碰到。
// 嵌一个 nil 接口而不是把 60 个方法抄一遍：真被调到就是空指针崩，
// 那正是我们想要的信号 —— 说明测试碰了不该碰的东西。
type paymentDisabled struct{ galaxy.Service }

func (paymentDisabled) PaymentEnabled() bool { return false }

type paymentEnabled struct{ galaxy.Service }

func (paymentEnabled) PaymentEnabled() bool { return true }
