package repository

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"gorm.io/gorm"
)

// 让录制连接池也能走 Tx：开事务就返回自己，提交、回滚什么都不做。语句照样一条条记下来。
func (p *recordingPool) BeginTx(context.Context, *sql.TxOptions) (gorm.ConnPool, error) {
	return p, nil
}
func (p *recordingPool) Commit() error   { return nil }
func (p *recordingPool) Rollback() error { return nil }

// TestSaveWritesUnlisted 盯住「下架保存成功、库里还是上架」。
//
// listed 的标签默认值是 true，GORM 建记录时会把 false 换成默认值插进去，upsert 的
// VALUES(listed) 跟着也是 true。保存之后必须单独把 listed=false 写一遍。
func TestSaveWritesUnlisted(t *testing.T) {
	cases := []struct {
		name  string
		save  func(repository *GalaxyRepository) error
		table string
	}{
		{"套餐", func(repository *GalaxyRepository) error {
			return repository.SavePackage(context.Background(), &GalaxyPackage{BizLine: "galaxy", PackageCode: "starter", Title: "入门包", Listed: false})
		}, "zt_galaxy_package"},
		{"模型目录", func(repository *GalaxyRepository) error {
			return repository.SaveModel(context.Background(), &GalaxyModel{BizLine: "galaxy", ModelID: "claude-sonnet-5", Listed: false})
		}, "zt_galaxy_model"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			repository, pool := recordingRepository(t)
			if err := item.save(repository); err != nil {
				t.Fatalf("save: %v", err)
			}
			index := len(pool.statements) - 1
			if index < 0 {
				t.Fatal("一条语句都没有下发")
			}
			statement, args := pool.statements[index], pool.args[index]
			if !strings.Contains(statement, "UPDATE `"+item.table+"` SET `listed`=?") || len(args) == 0 || args[0] != false {
				t.Fatalf("保存之后要单独写 listed=false，实际最后一条：%s %v", statement, args)
			}
		})
	}
}
