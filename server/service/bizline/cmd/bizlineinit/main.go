// Command bizlineinit 初始化业务线主数据表。
//
//	cd server/web-api
//	go run service/bizline/cmd/bizlineinit
package main

import (
	"log"

	"common/middleware/db"
	"common/middleware/httpx"
	bizlinerepo "service/bizline/internal/repository"
)

func main() {
	httpx.Boot("bizlineinit")
	repo := db.GetRepository[bizlinerepo.BizLineRepository]()
	if err := repo.AutoMigrate(); err != nil {
		log.Fatalf("初始化业务线表失败：%v", err)
	}
	log.Println("zt_bizline_def 和 zt_bizline_capability 已就绪，请在控制台创建业务线")
}
