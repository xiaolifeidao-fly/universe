package kinds

import "contract"

func Relay(providers map[string]string, bodyLimit int64) contract.KindSpec {
	spec := contract.KindSpec{
		Kind:      "llm.chat",
		Version:   1,
		Primitive: contract.PrimitiveRelay,
		Families:  []string{"anthropic", "openai"},
	}
	for _, family := range spec.Families {
		spec.Providers = append(spec.Providers, providers[family])
	}
	spec.Metering.Units = []contract.MeterUnit{
		contract.UnitInputTokens, contract.UnitOutputTokens,
		contract.UnitCacheReadTokens, contract.UnitCacheWriteTokens,
		// 四个桶的合计，给主人一条「整台机器一天最多跑多少 token」的上限用。
		// 它和上面四个同时出现在计量里，所以只能进额度和统计，不能进账本 ——
		// 见 contract.UnitTotalTokens 与 billing.go 的拦截。
		contract.UnitTotalTokens,
		contract.UnitCalls, contract.UnitTimeSeconds,
	}
	// 全部单位都由 Hub 自己计量：token 从透传的流里解析，次数与时长自己算。
	spec.Metering.Trusted = spec.Metering.Units
	spec.Placement.Affinity = contract.AffinitySoft
	spec.Placement.LocalityHint = "none"
	// 幂等仅在首字节之前成立：已经流出去的字节收不回来。
	spec.Retry.Idempotent = true
	spec.Retry.MaxAttempts = 2
	spec.Lease.RenewSec = 60
	spec.Lease.MaxRunSec = 600
	spec.Retention.Inputs = "0"
	spec.Retention.Outputs = "0"
	spec.Context.Schema = "none"
	spec.Context.Resume = "none"
	spec.Input.MaxInlineBytes = int(bodyLimit)
	return spec
}

func Delivery(providers []string) contract.KindSpec {
	spec := contract.KindSpec{
		Kind: "delivery.task", Version: 1, Primitive: contract.PrimitiveSession,
		Providers: providers,
	}
	spec.Metering.Units = []contract.MeterUnit{
		contract.UnitInputTokens, contract.UnitOutputTokens, contract.UnitCalls, contract.UnitTimeSeconds,
	}
	// token 由节点自报：回合是 agent 在本机跑出来的，Hub 看不到上游那条流，
	// 解析不了 token。次数与时长仍由 Hub 自己计。
	spec.Metering.Trusted = []contract.MeterUnit{contract.UnitCalls, contract.UnitTimeSeconds}
	spec.Placement.Affinity = contract.AffinityHard
	// 回合不幂等：agent 会写文件、跑命令，重跑一次不等于没跑过。
	spec.Retry.Idempotent = false
	spec.Retry.MaxAttempts = 1
	spec.Lease.RenewSec = 60
	spec.Lease.MaxRunSec = 3600
	spec.Retention.Inputs = "7d"
	spec.Retention.Outputs = "30d"
	spec.Context.Schema = "context-delta.v1.schema.json"
	spec.Context.Resume = "ledger+checkpoint"
	spec.Input.MaxInlineBytes = 256 << 10
	return spec
}

func VideoFarm(providers []string, diskGB, netMbps float64) contract.KindSpec {
	spec := contract.KindSpec{
		Kind: "video.edit.render", Version: 1, Primitive: contract.PrimitiveJob,
		Providers: providers,
	}
	spec.Metering.Units = []contract.MeterUnit{
		contract.UnitVideoOutputSeconds, contract.UnitCPUSeconds,
		contract.UnitStorageBytes, contract.UnitTimeSeconds,
	}
	// 输出时长与 CPU 秒只有跑的那台机器知道，Hub 采信节点自报；
	// 时长与存储由 Hub 自己算（前者看租约，后者看产物元数据）。
	spec.Metering.Trusted = []contract.MeterUnit{contract.UnitTimeSeconds, contract.UnitStorageBytes}
	spec.Placement.Affinity = contract.AffinityNone
	spec.Placement.Requires = map[string]any{
		"diskFreeGB": diskGB,
		"netMbps":    netMbps,
	}
	// 数据引力：优先落在缓存了输入素材的机器上，省一次 GB 级下载。
	spec.Placement.LocalityHint = "inputs"
	// 幂等：输入在 OSS 上，任意节点按 attempt 重跑一遍结果一样。
	spec.Retry.Idempotent = true
	spec.Retry.MaxAttempts = 2
	spec.Lease.RenewSec = 60
	spec.Lease.MaxRunSec = 7200
	spec.Retention.Inputs = "24h"
	spec.Retention.Outputs = "7d"
	spec.Context.Schema = "none"
	spec.Context.Resume = "none"
	spec.Input.MaxInlineBytes = 256 << 10
	return spec
}
