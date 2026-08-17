// Command bizlineinit 初始化业务线主数据表，并幂等写入 WhatsApp 默认业务线。
//
//	cd server/web-api
//	go run service/bizline/cmd/bizlineinit
package main

import (
	"context"
	"log"

	"common/middleware/db"
	"common/middleware/httpx"
	"service/bizline"
	bizlinedto "service/bizline/dto"
	bizlinerepo "service/bizline/internal/repository"
)

func main() {
	database := httpx.Boot("bizlineinit")
	repo := db.GetRepository[bizlinerepo.BizLineRepository]()
	if err := repo.AutoMigrate(); err != nil {
		log.Fatalf("初始化业务线表失败：%v", err)
	}
	if err := bizline.New(database, nil).Save(context.Background(), bizlinedto.SaveBizLineRequest{
		Code: "whatsapp", Name: "WhatsApp", Enabled: true,
	}); err != nil {
		log.Fatalf("初始化默认业务线失败：%v", err)
	}
	log.Println("zt_bizline_def 和 zt_bizline_capability 已就绪")
}
