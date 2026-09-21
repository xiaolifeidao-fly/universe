package routers

import (
	"strings"

	"gorm.io/gorm"

	"common/middleware/httpx"
	"galaxy-common/bootstrap"
	"galaxy-consumer-api/pkg/auth"
	"galaxy-consumer-api/pkg/consumers"
	"galaxy-consumer-api/pkg/portal"
)

type Assembly struct {
	*bootstrap.Assembly
	Auth      *auth.Handler
	Consumers *consumers.Handler
	Portal    *portal.Handler
}

func Build(database *gorm.DB) (*Assembly, error) {
	base, err := bootstrap.Build(database, nil, nil)
	if err != nil {
		return nil, err
	}
	accounts, gate := bootstrap.Accounts(database, base.Galaxy)
	return &Assembly{Assembly: base, Auth: auth.NewHandler(accounts, gate), Consumers: consumers.NewHandler(base.Galaxy, gate, consumers.Options{Models: strings.Split(httpx.Property("galaxy.models"), ",")}), Portal: portal.NewHandler(base.Galaxy, portal.Options{Models: strings.Split(httpx.Property("galaxy.models"), ","), CacheTTL: bootstrap.DurationProperty("galaxy.portal.cache_ttl_ms", 30000), LeadsPerHour: bootstrap.IntProperty("galaxy.portal.leads_per_hour", 60)})}, nil
}
