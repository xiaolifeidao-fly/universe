package routers

import (
	"gorm.io/gorm"

	"galaxy-api/pkg/auth"
	"galaxy-api/pkg/providers"
	"galaxy-common/bootstrap"
)

type Assembly struct {
	*bootstrap.Assembly
	Auth      *auth.Handler
	Providers *providers.Handler
}

func Build(database *gorm.DB) (*Assembly, error) {
	base, err := bootstrap.Build(database, nil, nil)
	if err != nil {
		return nil, err
	}
	accounts, gate := bootstrap.Accounts(database, base.Galaxy)
	return &Assembly{Assembly: base, Auth: auth.NewHandler(accounts, gate), Providers: providers.NewHandler(base.Galaxy, gate)}, nil
}
