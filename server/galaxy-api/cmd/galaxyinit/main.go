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
	"service/galaxy/dto"
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
	// 四个 token 桶互不重叠（见 migrations/20260918_galaxy_cache_write_price.sql）：
	// 新增输入 / 输出 / 缓存读 / 缓存写。缓存写原先没有种子价，于是这个单位
	// 一直「有量无价」、账上静默算 0；这里按上游通行的 1.25 倍输入价补上。
	prices := map[contract.MeterUnit]int64{
		contract.UnitInputTokens:      3_000_000,
		contract.UnitOutputTokens:     15_000_000,
		contract.UnitCacheReadTokens:  300_000,
		contract.UnitCacheWriteTokens: 3_750_000,
	}
	// 结算给共享者的价。**和上面那张表各填各的** —— 它不是对外价乘一个比例，
	// 只是默认值恰好取了七成。以后调对外价不会自动改共享者的收入，反过来也一样。
	providerPrices := map[contract.MeterUnit]int64{
		contract.UnitInputTokens:      2_100_000,
		contract.UnitOutputTokens:     10_500_000,
		contract.UnitCacheReadTokens:  210_000,
		contract.UnitCacheWriteTokens: 2_625_000,
	}
	ctx := context.Background()
	if err := assembly.Galaxy.SeedPrices(ctx, "llm.chat", prices, providerPrices); err != nil {
		log.Fatalf("写入定价失败: %v", err)
	}
	log.Print("llm.chat 默认定价写入完成")

	// 任务宇宙同样按 token 计价：一个回合背后就是若干次 LLM 调用，
	// 换个计价单位只会让同一件事在两张账单上对不上。
	if err := assembly.Galaxy.SeedPrices(ctx, "delivery.task", prices, providerPrices); err != nil {
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

	// 一份内测额度商品，让购买链路开箱可跑。价格与额度都按运营口径再改。
	if err := assembly.Galaxy.SavePackage(ctx, dto.SavePackageRequest{
		PackageCode: "starter", Title: "入门包",
		Units: contract.Metering{
			contract.UnitInputTokens:  5_000_000,
			contract.UnitOutputTokens: 1_000_000,
		},
		Amount: 9_900_000, Currency: "CNY", TTLDays: 30,
	}); err != nil {
		log.Fatalf("写入额度商品失败: %v", err)
	}
	log.Print("starter 额度商品写入完成")
}
