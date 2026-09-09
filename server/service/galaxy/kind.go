package galaxy

import (
	"fmt"
	"sort"
	"sync"

	"contract"
)

// 能力注册表：kind → 原语 · provider · 计量单位 · 策略。
// 静态注册，Hub 启动时由各适配器交进来，放置与额度按它做决策。
// 通用层不 import 任何业务包（X-05），所以注册表只存 KindSpec 这一种形状。

type KindRegistry struct {
	mu    sync.RWMutex
	specs map[string]contract.KindSpec // KindRef → spec
	// latest 记录每个 kind 的最高版本，供只写 kind 不写版本的调用方定位。
	latest map[string]int
}

func NewKindRegistry(specs ...contract.KindSpec) *KindRegistry {
	registry := &KindRegistry{specs: map[string]contract.KindSpec{}, latest: map[string]int{}}
	for _, spec := range specs {
		_ = registry.Register(spec)
	}
	return registry
}

// Register 登记一条能力。同 kind 同版本重复登记直接报错 ——
// 两个适配器抢同一个 kind 是装配错误，不该让后者悄悄覆盖前者。
func (r *KindRegistry) Register(spec contract.KindSpec) error {
	if spec.Kind == "" || spec.Version <= 0 {
		return fmt.Errorf("kind 注册缺少名称或版本")
	}
	if !spec.Primitive.Valid() {
		return fmt.Errorf("kind %s 的原语非法: %s", spec.Kind, spec.Primitive)
	}
	if len(spec.Providers) == 0 {
		return fmt.Errorf("kind %s 未声明 provider", spec.Kind)
	}
	if len(spec.Metering.Units) == 0 {
		return fmt.Errorf("kind %s 未声明计量单位", spec.Kind)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	ref := spec.Ref()
	if _, exists := r.specs[ref]; exists {
		return fmt.Errorf("kind %s 重复注册", ref)
	}
	r.specs[ref] = spec
	if spec.Version > r.latest[spec.Kind] {
		r.latest[spec.Kind] = spec.Version
	}
	return nil
}

func (r *KindRegistry) Lookup(kind string, version int) (contract.KindSpec, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if version <= 0 {
		version = r.latest[kind]
	}
	spec, ok := r.specs[contract.KindRef(kind, version)]
	return spec, ok
}

func (r *KindRegistry) List() []contract.KindSpec {
	r.mu.RLock()
	defer r.mu.RUnlock()
	specs := make([]contract.KindSpec, 0, len(r.specs))
	for _, spec := range r.specs {
		specs = append(specs, spec)
	}
	sort.Slice(specs, func(i, j int) bool {
		if specs[i].Kind == specs[j].Kind {
			return specs[i].Version < specs[j].Version
		}
		return specs[i].Kind < specs[j].Kind
	})
	return specs
}

// ValidateCapability 只看「这个能力这套 Hub 认不认」，不问额度和座位。
//
// 节点上报能力清单时用它：那一刻还没有额度也没有座位 —— 共享多少是主人在控制台
// 定的事，节点无权表态。带额度的完整校验留给 ValidateContribution，
// 在主人真的开启一条贡献时才跑。
func (r *KindRegistry) ValidateCapability(kind string, version int, provider string) (contract.KindSpec, error) {
	spec, ok := r.Lookup(kind, version)
	if !ok {
		return contract.KindSpec{}, fmt.Errorf("%w: %s", contract.ErrKindNotRegistered, contract.KindRef(kind, version))
	}
	if !spec.SupportsProvider(provider) {
		return spec, fmt.Errorf("provider %s 不属于 %s", provider, spec.Kind)
	}
	return spec, nil
}

// ValidateContribution 校验一条**要开启**的贡献：在能力本身之外，还要额度单位
// 属于这个 kind、座位数不超平台上限。
func (r *KindRegistry) ValidateContribution(kind string, version int, provider string, units []contract.MeterUnit, seats, platformSeatLimit int) (contract.KindSpec, error) {
	spec, err := r.ValidateCapability(kind, version, provider)
	if err != nil {
		return spec, err
	}
	for _, unit := range units {
		if !spec.AllowsUnit(unit) {
			return spec, fmt.Errorf("计量单位 %s 不属于 %s", unit, spec.Kind)
		}
	}
	if platformSeatLimit > 0 && seats > platformSeatLimit {
		return spec, fmt.Errorf("座位数 %d 超过平台上限 %d", seats, platformSeatLimit)
	}
	return spec, nil
}
