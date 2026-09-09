package repository

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"os"
	"regexp"
	"strings"
	"testing"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// recordingPool 是一个只记不执行的连接池。
// 让 GORM 自己走一遍建表流程，把它真正会下发的 DDL 抄下来 ——
// 手写 galaxy.sql 必然和 AutoMigrate 建出来的对不上，字段类型和索引名都会漂。
//
// 同一套记录也用来盯住几条「写错了不会报错、只会悄悄改坏数据」的 UPDATE，
// 见 node_test.go：语句和绑定值都抄下来，才能断言 WHERE 里那个条件真的在。
type recordingPool struct {
	statements []string
	args       [][]any
}

func (p *recordingPool) PrepareContext(context.Context, string) (*sql.Stmt, error) { return nil, nil }

func (p *recordingPool) ExecContext(_ context.Context, query string, args ...any) (sql.Result, error) {
	p.statements = append(p.statements, query)
	p.args = append(p.args, args)
	return driver.RowsAffected(0), nil
}

func (p *recordingPool) QueryContext(context.Context, string, ...any) (*sql.Rows, error) {
	return nil, sql.ErrNoRows
}

func (p *recordingPool) QueryRowContext(context.Context, string, ...any) *sql.Row { return nil }

// generateDDL 返回 AutoMigrate 会下发的建表语句。
func generateDDL(t *testing.T) []string {
	t.Helper()
	pool := &recordingPool{}
	// 这里的 mysql.Config 必须和 httpx.Boot 里那个 mysql.Open(dsn) 的默认行为一致 ——
	// 多设一个 DisableDatetimePrecision，导出的就是 datetime 而线上建的是 datetime(3)，
	// 这份 SQL 就成了「跑完还会被 AutoMigrate 改一遍」的假保证。
	database, err := gorm.Open(mysql.New(mysql.Config{
		Conn: pool, SkipInitializeWithVersion: true,
	}), &gorm.Config{
		DisableForeignKeyConstraintWhenMigrating: true,
		Logger:                                   logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	migrator := database.Migrator()
	for _, model := range models() {
		if err := migrator.CreateTable(model); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
	return pool.statements
}

// TestDumpDDL 只在设置了 GALAXY_DDL_OUT 时才写文件，平时是个空跑的 no-op。
// 重新生成：GALAXY_DDL_OUT=/tmp/galaxy.sql go test ./service/galaxy/internal/repository/ -run TestDumpDDL
func TestDumpDDL(t *testing.T) {
	out := os.Getenv("GALAXY_DDL_OUT")
	if out == "" {
		t.Skip("设置 GALAXY_DDL_OUT 才导出")
	}
	statements := generateDDL(t)
	if err := os.WriteFile(out, []byte(strings.Join(statements, ";\n\n")+";\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	t.Logf("导出 %d 条语句到 %s", len(statements), out)
}

// bareTimestamp 匹配没有显式 NULL 的 TIMESTAMP 列。
var bareTimestamp = regexp.MustCompile("`(\\w+)` timestamp(?i:(?: null)?)")

// TestEveryTimestampColumnIsNullable 盯住一个一半是静默的坑。
//
// MySQL 在 explicit_defaults_for_timestamp=OFF 时（5.7 默认，8.x 也可能被配成这样），
// 对没有显式 NULL / DEFAULT 的 TIMESTAMP 列做两件事：
//
//	每张表的第一个 → 静默补上 NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
//	第二个及以后   → 补上 DEFAULT '0000-00-00'，被 NO_ZERO_DATE 拒绝，建表报 1067
//
// 报错那半反而是好事。静默那半才要命：zt_galaxy_price.effective_from 在唯一键里，
// 带上 ON UPDATE 之后任何一次 UPDATE 都会改写它，定价历史当场就乱。
//
// 模型上必须写成 `type:timestamp null`。写 `type:timestamp;null` 是个空写法 ——
// GORM 不认识那个标签元素，发出去的 DDL 里没有 NULL，这条测试就是为了拦住它。
func TestEveryTimestampColumnIsNullable(t *testing.T) {
	for _, statement := range generateDDL(t) {
		for _, match := range bareTimestamp.FindAllStringSubmatch(statement, -1) {
			if strings.HasSuffix(strings.ToLower(match[0]), " null") {
				continue
			}
			table := "?"
			if name := regexp.MustCompile("CREATE TABLE `(\\w+)`").FindStringSubmatch(statement); name != nil {
				table = name[1]
			}
			t.Errorf("%s.%s 是裸 TIMESTAMP，模型上要写 `type:timestamp null`", table, match[1])
		}
	}
}

// TestGalaxySQLCoversEveryTable 盯住 galaxy.sql 的漂移。
//
// 它不比对列 —— 那太脆，改个字段长度就红。它只问一句：models() 里的每张表，
// galaxy.sql 里有没有？漏一张的后果是只跑 SQL 建库的环境在运行时报「表不存在」，
// 而这种错要等到那条代码路径第一次被走到才暴露。
func TestGalaxySQLCoversEveryTable(t *testing.T) {
	// 从 server/service/galaxy/internal/repository 数四级回到 server/。
	raw, err := os.ReadFile("../../../../galaxy.sql")
	if err != nil {
		// 不 Skip：文件不在本身就是要防的那件事，Skip 会让守卫悄悄失效。
		t.Fatalf("读不到 server/galaxy.sql：%v", err)
	}
	schema := string(raw)
	for _, model := range models() {
		namer, ok := model.(interface{ TableName() string })
		if !ok {
			t.Fatalf("%T 没有 TableName()", model)
		}
		table := namer.TableName()
		if !strings.Contains(schema, "`"+table+"`") {
			t.Errorf("galaxy.sql 里没有 %s —— 重新导出：见本文件顶部的 GALAXY_DDL_OUT 说明", table)
		}
	}
}
