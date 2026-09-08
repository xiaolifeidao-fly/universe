// Package core 是适配器契约与通道层胶水：把「一次消费者请求」变成「一个工作单元」，
// 再把节点回来的字节写回消费者。
//
// 它独立成 module 是为了避免包环：业务适配器 import 它，galaxy-api 的传输层也 import 它，
// 而它只 import service/galaxy 与 contract，永远不 import 任何业务包（X-05）。
package core

import (
	"context"
	"log/slog"

	"github.com/gin-gonic/gin"

	"contract"
	"service/galaxy"
	"service/galaxy/dto"
)

// Caller 是一次消费者请求认定后的身份。
type Caller = dto.Caller

// Input 是适配器 Parse 的产物。通用层对它完全不透明。
type Input any

// Deps 适配器能用到的全部平台能力。
type Deps struct {
	Galaxy   galaxy.Service
	Exchange *Exchange
	// Journal 是 session / job 的事件日志。relay 用不到它。
	Journal *Journal
	Log     *slog.Logger
}

// Route 一条消费者侧路由。
type Route struct {
	Method string
	Path   string
}

// EventWriter 把节点回来的字节 / 事件写成消费者要的响应形态。
// relay 原样对拷，session / job 各自组装事件流。
type EventWriter interface {
	// Head 首字节到达时把上游状态码与白名单头写给消费者并 flush。
	Head(status int, headers map[string]string)
	Write(chunk []byte) error
	End()
	Abort(err error)
	// Usage 是 Hub 自己从流里解析出的用量。平台侧计量优先（S-04），
	// 它比节点自报的值更可信，节点自报只用于对账。
	Usage() contract.Metering
}

// Adapter 一种业务能力在 Hub 侧的全部解读点。
// 通用层只在 Parse 进、Writer 出这两处让业务参与，其余一律不认识业务。
type Adapter interface {
	Kind() contract.KindSpec
	Routes() []Route

	// Parse 校验并解析入参。失败即 input_fault，不派单。
	Parse(ctx *gin.Context) (Input, error)
	// Route 产出路由键。需要查 previous_response_id 这类平台状态时可以用 ctx。
	Route(ctx context.Context, in Input) (contract.RouteKey, error)
	Estimate(in Input) contract.Metering
	ToUnit(in Input, caller Caller) contract.WorkUnit
	// Writer 拿得到已解析的入参：Parse 阶段的决定（比如 Hub 注入过哪些参数）
	// 要一直影响到写回，不该借 gin 上下文这种侧通道传递。
	Writer(ctx *gin.Context, in Input, unit contract.WorkUnit) EventWriter
	// ToError 把 Hub 侧错误渲染成该协议族的错误体形态。
	ToError(in Input, status int, code, message string) any
}

// Signing 是写回器的可选能力：交出响应的结构签名，供抽检比对。
// 签名里只有事件名与形状，没有任何内容，可以安全落库。
type Signing interface {
	Signature() string
}

// SelfRegistering 让适配器挂自己的辅助路由：会话管理、事件回放这类不派单的接口。
// Routes() 只列真正会产生工作单元的路径，两者分开，通用层才不用去猜哪条路要派单。
type SelfRegistering interface {
	RegisterExtra(group *gin.RouterGroup, deps Deps)
}

// Intercepting 让适配器在放置之前直接接管一次请求：幂等重放、缓存命中都走它。
// 返回 true 表示响应已经写完，通道层不再派单。
type Intercepting interface {
	Intercept(ctx *gin.Context, in Input) bool
}

// Accepting 是 session / job 适配器的可选能力：提交是异步的，
// 由适配器决定「受理成功」这条响应长什么样。不实现就用通用形态。
type Accepting interface {
	Accepted(ctx *gin.Context, in Input, unit contract.WorkUnit, placement galaxy.Placement)
}

// Registry 装配启用的适配器，并把 kind 交给共享池注册表。
type Registry struct {
	adapters []Adapter
}

func NewRegistry(adapters ...Adapter) *Registry {
	return &Registry{adapters: adapters}
}

func (r *Registry) Adapters() []Adapter { return r.adapters }

// Kinds 供 galaxy.NewKindRegistry 使用：能力注册表的唯一来源是适配器自己。
func (r *Registry) Kinds() []contract.KindSpec {
	specs := make([]contract.KindSpec, 0, len(r.adapters))
	for _, adapter := range r.adapters {
		specs = append(specs, adapter.Kind())
	}
	return specs
}
