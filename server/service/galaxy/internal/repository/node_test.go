package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// recordingRepository 一个只记不执行的仓储：语句和绑定值都抄下来。
// 这几条 UPDATE 少一个 WHERE 条件照样跑通、照样返回 nil，只有把 SQL 本身
// 摊开看才发现改到了不该改的行。
func recordingRepository(t *testing.T) (*GalaxyRepository, *recordingPool) {
	t.Helper()
	pool := &recordingPool{}
	database, err := gorm.Open(mysql.New(mysql.Config{
		Conn: pool, SkipInitializeWithVersion: true,
	}), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	repository := &GalaxyRepository{}
	repository.SetDb(database)
	return repository, pool
}

// lastStatement 最后一条下发出去的语句，连同它的绑定值拼成一行方便断言。
func lastStatement(t *testing.T, pool *recordingPool) string {
	t.Helper()
	if len(pool.statements) == 0 {
		t.Fatal("一条语句都没有下发")
	}
	index := len(pool.statements) - 1
	return fmt.Sprintf("%s %v", pool.statements[index], pool.args[index])
}

// TestMarkNodeOfflineSkipsRevoked 盯住一台会自己长回来的僵尸机器。
//
// 巡检是按贡献倒推节点的：贡献在控制面里没有快照，就把它那台机器记成离线。
// 撤销恰恰会造出这个局面 —— 控制面被摘干净了，库里的贡献行还在。少了这个
// WHERE，撤销之后最迟一分钟，巡检就把 revoked 改回 offline，机器回到主人的
// 总览里，而它的令牌已经置空，永远连不回来：撤了又回来，再撤还是回来。
func TestMarkNodeOfflineSkipsRevoked(t *testing.T) {
	repository, pool := recordingRepository(t)
	if err := repository.MarkNodeOffline(context.Background(), "galaxy", "n_zombie"); err != nil {
		t.Fatalf("mark offline: %v", err)
	}
	statement := lastStatement(t, pool)
	if !strings.Contains(statement, "status <> ?") || !strings.Contains(statement, "revoked") {
		t.Fatalf("降为离线必须放过撤销掉的机器，实际下发：%s", statement)
	}
}

// TestDisableContributionsByNodeStaysOnItsNode 撤销与封禁都靠它清场，
// 一条贡献都不能漏，更不能越界关掉别人机器上的。
func TestDisableContributionsByNodeStaysOnItsNode(t *testing.T) {
	repository, pool := recordingRepository(t)
	if err := repository.DisableContributionsByNode(context.Background(), "galaxy", "n_zombie"); err != nil {
		t.Fatalf("disable contributions: %v", err)
	}
	statement := lastStatement(t, pool)
	if !strings.Contains(statement, "galaxy_contribution") {
		t.Fatalf("改的不是贡献表：%s", statement)
	}
	for _, want := range []string{"node_id = ?", "biz_line = ?", "n_zombie", "disabled"} {
		if !strings.Contains(statement, want) {
			t.Fatalf("语句里缺了 %s：%s", want, statement)
		}
	}
}

// queryPool 在 recordingPool 之上把查询也抄下来。查询一律答「没有行」——
// 要盯的是 WHERE 条件，不是结果。
type queryPool struct {
	recordingPool
}

func (p *queryPool) QueryContext(_ context.Context, query string, args ...any) (*sql.Rows, error) {
	p.statements = append(p.statements, query)
	p.args = append(p.args, args)
	return nil, sql.ErrNoRows
}

func queryRecordingRepository(t *testing.T) (*GalaxyRepository, *queryPool) {
	t.Helper()
	pool := &queryPool{}
	database, err := gorm.Open(mysql.New(mysql.Config{
		Conn: pool, SkipInitializeWithVersion: true,
	}), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	repository := &GalaxyRepository{}
	repository.SetDb(database)
	return repository, pool
}

// TestNodeNamesKeepsRevokedButStaysWithOwner 执行记录要标出是哪台机器跑的。
//
// 两个条件缺一不可：跑活的那台可能早就解绑了，照 ListNodesByOwner 那样滤掉 revoked，
// 老记录就只剩一串 id；owner 条件一丢，拿到别人的 node_id 就能读到别人给机器起的名字。
func TestNodeNamesKeepsRevokedButStaysWithOwner(t *testing.T) {
	repository, pool := queryRecordingRepository(t)
	_, _ = repository.NodeNames(context.Background(), "galaxy", "u_owner", []string{"n_mac", "n_rack"})
	statement := lastStatement(t, &pool.recordingPool)
	for _, want := range []string{"biz_line = ?", "owner_user_id = ?", "u_owner", "node_id IN", "n_mac", "n_rack"} {
		if !strings.Contains(statement, want) {
			t.Fatalf("语句里缺了 %s：%s", want, statement)
		}
	}
	if strings.Contains(statement, "status") {
		t.Fatalf("解绑的机器也得查得出名字，不能按状态过滤：%s", statement)
	}
	if strings.Contains(statement, "SELECT *") {
		t.Fatalf("只取名字两列，别把回连密钥一起捞出来：%s", statement)
	}
}

// TestNodeNamesSkipsEmptyIDs 这一页一条记录都没有时不查库。
func TestNodeNamesSkipsEmptyIDs(t *testing.T) {
	repository, pool := queryRecordingRepository(t)
	names, err := repository.NodeNames(context.Background(), "galaxy", "u_owner", nil)
	if err != nil || len(names) != 0 || len(pool.statements) != 0 {
		t.Fatalf("没有 id 不该查库：names=%v err=%v statements=%v", names, err, pool.statements)
	}
}
