// Command identityinit creates identity tables and the configured initial administrator.
package main

import (
	"context"
	"log"
	"strconv"
	"time"

	"common/middleware/db"
	"common/middleware/httpx"
	"service/delivery"
	"service/identity"
	identityrepo "service/identity/internal/repository"
)

func main() {
	database := httpx.Boot("identityinit")
	repo := db.GetRepository[identityrepo.IdentityRepository]()
	if err := repo.AutoMigrate(); err != nil {
		log.Fatalf("初始化身份表失败：%v", err)
	}
	ttl, _ := strconv.Atoi(httpx.Property("auth.token_ttl_seconds"))
	service := identity.New(database, delivery.New(database), httpx.Property("auth.token_secret"), time.Duration(ttl)*time.Second)
	if err := service.EnsureDefaultAdmin(
		context.Background(),
		httpx.Property("auth.default_username"),
		httpx.Property("auth.default_display_name"),
		httpx.Property("auth.default_password"),
	); err != nil {
		log.Fatalf("初始化默认管理员失败：%v", err)
	}
	log.Println("zt_identity_* 表和默认管理员已就绪")
}
