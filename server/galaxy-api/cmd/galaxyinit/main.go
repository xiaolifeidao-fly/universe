// galaxyinit 建表并写入中转站的默认定价。
//
// 建表不做成进程启动的副作用：线上 DDL 该是一次显式的发布动作。
// 用法：在 server/galaxy-api 目录下 `go run ./cmd/galaxyinit`
package main

import (
	"context"
	"log"

	"common/middleware/httpx"
	"contract"
	"galaxy-api/routers"
	"service/galaxy"
)

func main() {
	database := httpx.Boot("galaxy-api")
	if err := galaxy.Migrate(database); err != nil {
		log.Fatalf("建表失败: %v", err)
	}
	log.Print("zt_galaxy_* 建表完成")

	assembly, err := routers.Build(database)
	if err != nil {
		log.Fatalf("装配失败: %v", err)
	}
	defer func() { _ = assembly.Control.Close() }()

	// 中转站定价（决策 D-02 / D-03）：input 与 output 分别定价，
	// 缓存读取按 input 折扣；calls 与 time.seconds 不计价，只作供给侧额度与统计。
	// 单位是「每百万 token 的微分」，即 3_000_000 微分 = 30 元 / 百万 token。
	//
	// 缓存写入要给**两个 TTL 桶**定价，不是给合计定价。
	//
	// llm.cache_write_tokens 是 5m 与 1h 的合计（见 kinds.Relay 与 relay/usage.go
	// 的 putCacheWrite），billing 的 derivedUnits 把它挡在账本外 —— 给合计填价
	// 一分钱都收不到，而界面上看着像已经定过了。真正进账本的是下面这两个。
	// 价按上游通行的倍率：5 分钟是输入价的 1.25 倍，1 小时是 2 倍。
	prices := map[contract.MeterUnit]int64{
		contract.UnitInputTokens:        3_000_000,
		contract.UnitOutputTokens:       15_000_000,
		contract.UnitCacheReadTokens:    300_000,
		contract.UnitCacheWrite5mTokens: 3_750_000,
		contract.UnitCacheWrite1hTokens: 6_000_000,
	}
	// 结算给共享者的价。**和上面那张表各填各的** —— 它不是对外价乘一个比例，
	// 只是默认值恰好取了七成。以后调对外价不会自动改共享者的收入，反过来也一样。
	providerPrices := map[contract.MeterUnit]int64{
		contract.UnitInputTokens:        2_100_000,
		contract.UnitOutputTokens:       10_500_000,
		contract.UnitCacheReadTokens:    210_000,
		contract.UnitCacheWrite5mTokens: 2_625_000,
		contract.UnitCacheWrite1hTokens: 4_200_000,
	}
	ctx := context.Background()
	if err := assembly.Galaxy.SeedPrices(ctx, "llm.chat", prices, providerPrices); err != nil {
		log.Fatalf("写入定价失败: %v", err)
	}
	log.Print("llm.chat 默认定价写入完成")

	// 任务宇宙同样按 token 计价：一个回合背后就是若干次 LLM 调用，
	// 换个计价单位只会让同一件事在两张账单上对不上。
	//
	// 但它只计量 input / output（回合是 agent 在本机跑的，Hub 看不到上游那条流，
	// 解析不了缓存桶），所以缓存那几档在这个 kind 下永远没有量，填了也是空行。
	deliveryPrices := map[contract.MeterUnit]int64{
		contract.UnitInputTokens:  prices[contract.UnitInputTokens],
		contract.UnitOutputTokens: prices[contract.UnitOutputTokens],
	}
	deliveryProviderPrices := map[contract.MeterUnit]int64{
		contract.UnitInputTokens:  providerPrices[contract.UnitInputTokens],
		contract.UnitOutputTokens: providerPrices[contract.UnitOutputTokens],
	}
	if err := assembly.Galaxy.SeedPrices(ctx, "delivery.task", deliveryPrices, deliveryProviderPrices); err != nil {
		log.Fatalf("写入定价失败: %v", err)
	}

	// 视频渲染按输出时长与算力秒计价（O-01 的建议口径）。
	if err := assembly.Galaxy.SeedPrices(ctx, "video.edit.render", map[contract.MeterUnit]int64{
		contract.UnitVideoOutputSeconds: 20_000_000, // 每百万秒 20 元 → 每秒 0.00002 元
		contract.UnitCPUSeconds:         2_000_000,
	}, map[contract.MeterUnit]int64{
		contract.UnitVideoOutputSeconds: 14_000_000,
		contract.UnitCPUSeconds:         1_400_000,
	}); err != nil {
		log.Fatalf("写入定价失败: %v", err)
	}
	log.Print("delivery.task / video.edit.render 默认定价写入完成")

	// 不再播额度商品：使用端不卖包了，调模型按单价逐笔扣账户里的积分余额。
	// 空库上要把链路跑通，缺的是**余额**而不是商品 —— 在管理端给账号充一笔积分即可。
}
