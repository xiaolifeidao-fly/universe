// Command dlvimport 建交付推进的八张表，并把原型 assets/tasks.json 导进去。
//
// 建表放在这里而不是服务启动时：线上 DDL 不该是进程启动的副作用。
//
//	cd server/web-api            # 为了读到 configs/application.properties
//	go run service/delivery/cmd/dlvimport \
//	    -file ../../../solution/yinni-ai-solution/yinni-分析/assets/tasks.json \
//	    -program-id 1 -bizline whatsapp
//
// 只建表不导数据：省掉 -file。重复执行是幂等的（按 item_key upsert）。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"os"

	"common/middleware/db"
	"common/middleware/httpx"

	"contract"
	"service/delivery"
	deliverydto "service/delivery/dto"
	deliveryrepo "service/delivery/internal/repository"
)

func main() {
	file := flag.String("file", "", "原型 assets/tasks.json 路径，留空则只建表")
	programID := flag.Int64("program-id", 0, "已存在项目的数值主键")
	programName := flag.String("name", "", "项目名称，留空取 tasks.json 的 meta.name")
	bizLine := flag.String("bizline", "whatsapp", "业务线")
	actor := flag.String("actor", "dlvimport", "操作人，写进流水")
	flag.Parse()

	database := httpx.Boot("dlvimport")

	repo := db.GetRepository[deliveryrepo.DeliveryRepository]()
	if err := repo.AutoMigrate(); err != nil {
		log.Fatalf("建表失败：%v", err)
	}
	log.Println("zt_delivery_* 八张表已就绪")

	if *file == "" {
		return
	}
	if *programID <= 0 {
		log.Fatal("导入必须提供已存在项目的 -program-id")
	}

	raw, err := os.ReadFile(*file)
	if err != nil {
		log.Fatalf("读取 %s 失败：%v", *file, err)
	}

	var req deliverydto.ImportRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		log.Fatalf("解析 tasks.json 失败：%v", err)
	}
	req.BizLine = contract.BizLine(*bizLine)
	req.ProgramID = *programID
	req.ProgramName = *programName
	req.ActorID = *actor
	req.ActorName = *actor

	result, err := delivery.New(database).ImportItems(context.Background(), req)
	if err != nil {
		log.Fatalf("导入失败：%v", err)
	}
	log.Printf("导入完成：阶段 %d，模块 %d，新建任务 %d，更新任务 %d",
		result.Stages, result.Modules, result.Created, result.Updated)
}
