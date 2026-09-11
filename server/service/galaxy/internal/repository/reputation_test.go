package repository

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"os"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// TestAdjustReputationUpsertsEverySubjectScoreBeforeTimestamp 盯住那条 upsert。
//
// ON DUPLICATE KEY UPDATE 从左到右赋值，右边读到的是左边刚写进去的值。reputation_at 要是
// 排到前面，算回升时读到的就是「此刻」，关机十天该回升的分数凭空没了 —— 语句照样成功，
// 只是分数从此只降不升。账号、设备两份都要写到，少一份，改身份之后读到的就是没扣过的满分。
func TestAdjustReputationUpsertsEverySubjectScoreBeforeTimestamp(t *testing.T) {
	repository, pool := recordingRepository(t)
	at := time.Date(2026, 9, 11, 12, 0, 0, 0, time.Local)
	subjects := []string{"account:u_1", "device:fp"}
	if err := repository.AdjustReputation(context.Background(), "galaxy", subjects, -1, 0.05, at); err != nil {
		t.Fatalf("adjust: %v", err)
	}
	if len(pool.statements) != len(subjects) {
		t.Fatalf("每份信誉一条 upsert，期望 %d 条，实际 %d 条", len(subjects), len(pool.statements))
	}
	for index, subject := range subjects {
		statement := fmt.Sprintf("%s %v", pool.statements[index], pool.args[index])
		if !strings.Contains(statement, subject) {
			t.Fatalf("第 %d 条没写到 %s：%s", index+1, subject, statement)
		}
		split := strings.Index(statement, "ON DUPLICATE KEY UPDATE")
		if split < 0 {
			t.Fatalf("不是 upsert：%s", statement)
		}
		insert, update := statement[:split], statement[split:]
		score, stamp := strings.Index(update, "`reputation`="), strings.Index(update, "`reputation_at`=")
		if score < 0 || stamp < 0 || score > stamp {
			t.Fatalf("reputation 必须先于 reputation_at 赋值：%s", update)
		}
		// 第一次就扣到 0：reputation 列得在 INSERT 里，被当成零值省掉就成了库的默认值。
		if !strings.Contains(insert, "`reputation`,") {
			t.Fatalf("INSERT 里没有 reputation 列：%s", insert)
		}
	}
}

// TestFillNodeFingerprintOnlyFillsEmpty 指纹只补不改，老行的 NULL 也要算「空」。
func TestFillNodeFingerprintOnlyFillsEmpty(t *testing.T) {
	repository, pool := recordingRepository(t)
	if err := repository.FillNodeFingerprint(context.Background(), "galaxy", "n_1", "abc"); err != nil {
		t.Fatalf("fill: %v", err)
	}
	statement := lastStatement(t, pool)
	for _, want := range []string{"node_id = ?", "n_1", "machine_fingerprint IS NULL OR machine_fingerprint = ''"} {
		if !strings.Contains(statement, want) {
			t.Fatalf("语句里缺了 %s：%s", want, statement)
		}
	}
}

// TestSaveProviderTypeOverwritesByAccount 同一个账号改第二次是改那一行，不是再插一行；
// 留痕的 updated_by 跟着改。
func TestSaveProviderTypeOverwritesByAccount(t *testing.T) {
	repository, pool := recordingRepository(t)
	if err := repository.SaveProviderType(context.Background(), &GalaxyProvider{
		BizLine: "galaxy", OwnerUserID: "u_1", ProviderType: "studio", UpdatedBy: "m_admin",
	}); err != nil {
		t.Fatalf("save: %v", err)
	}
	statement := lastStatement(t, pool)
	for _, want := range []string{"ON DUPLICATE KEY UPDATE", "`provider_type`=VALUES(`provider_type`)", "`updated_by`=VALUES(`updated_by`)", "studio", "m_admin"} {
		if !strings.Contains(statement, want) {
			t.Fatalf("语句里缺了 %s：%s", want, statement)
		}
	}
}

// TestAdjustReputationOnMySQL 在真 MySQL 上跑那条 upsert。设置了 GALAXY_TEST_DSN 才跑：
//
//	GALAXY_TEST_DSN='user:pass@tcp(host:3306)/db?parseTime=True&loc=Local' go test ./service/galaxy/internal/repository/ -run OnMySQL
//
// 录下来的 SQL 只证明语句长什么样，证明不了 MySQL 怎么求值：回升有没有算进去、
// 赋值顺序对不对、扣到 0 会不会被写回满分。
//
// 只碰会话级临时表，不碰库里任何真表。用一条钉死的连接而不是连接池：临时表只对建它的
// 那条连接可见，池子要是中途换了连接，同名的写入就会落到真表上。
func TestAdjustReputationOnMySQL(t *testing.T) {
	dsn := os.Getenv("GALAXY_TEST_DSN")
	if dsn == "" {
		t.Skip("设置 GALAXY_TEST_DSN 才跑")
	}
	ctx := context.Background()
	pool, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = pool.Close() })
	conn, err := pool.Conn(ctx)
	if err != nil {
		t.Fatalf("conn: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	database, err := gorm.Open(mysql.New(mysql.Config{Conn: conn, SkipInitializeWithVersion: true}),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("gorm: %v", err)
	}
	if err := database.Exec("CREATE TEMPORARY TABLE `zt_galaxy_reputation` (" +
		"`id` bigint AUTO_INCREMENT, `biz_line` varchar(32), `subject` varchar(96), `reputation` double, " +
		"`reputation_at` timestamp NULL DEFAULT NULL, `created_time` datetime(3) NULL, `updated_time` datetime(3) NULL, " +
		"PRIMARY KEY (`id`), UNIQUE INDEX `uk_gx_reputation_subject` (`biz_line`,`subject`))").Error; err != nil {
		t.Fatalf("建临时表: %v", err)
	}
	// 往里写之前确认它真是临时表：哪天有人把上面的 TEMPORARY 删了，这条测试不能去改真表。
	var table, ddl string
	if err := database.Raw("SHOW CREATE TABLE `zt_galaxy_reputation`").Row().Scan(&table, &ddl); err != nil || !strings.HasPrefix(ddl, "CREATE TEMPORARY TABLE") {
		t.Fatalf("不是临时表，停下：%v %s", err, ddl)
	}

	repository := &GalaxyRepository{}
	repository.SetDb(database)
	day := 24 * time.Hour
	start := time.Date(2026, 9, 1, 12, 0, 0, 0, time.Local)
	adjust := func(delta float64, at time.Time, subjects ...string) {
		t.Helper()
		if err := repository.AdjustReputation(ctx, "galaxy", subjects, delta, 0.05, at); err != nil {
			t.Fatalf("adjust %v %v: %v", subjects, delta, err)
		}
	}
	expect := func(subject string, score float64, at time.Time, why string) {
		t.Helper()
		rows, err := repository.ListReputations(ctx, "galaxy", []string{subject})
		if err != nil || len(rows) != 1 {
			t.Fatalf("find %s: %d 行, %v", subject, len(rows), err)
		}
		if math.Abs(rows[0].Reputation-score) > 1e-9 || !rows[0].ReputationAt.Equal(at) {
			t.Fatalf("%s：期望 %.4f @ %s，实际 %.4f @ %s", why, score, at, rows[0].Reputation, rows[0].ReputationAt)
		}
	}

	adjust(-0.5, start, "account:u_1", "device:fp_a")
	expect("account:u_1", 0.5, start, "没有行时按满分起算")
	expect("device:fp_a", 0.5, start, "设备那一份同时记上")
	adjust(-0.1, start.Add(2*day), "account:u_1", "device:fp_b")
	expect("account:u_1", 0.5, start.Add(2*day), "两天回升 0.1 再扣 0.1（赋值顺序反了会是 0.4）")
	expect("device:fp_a", 0.5, start, "别的设备不受牵连")
	expect("device:fp_b", 0.9, start.Add(2*day), "账号的第二台机器从满分起扣")
	adjust(-0.05, start.Add(30*day), "account:u_1")
	expect("account:u_1", 0.95, start.Add(30*day), "早就回满，封顶 1 之后再扣")
	adjust(-1, start, "device:fp_zero")
	expect("device:fp_zero", 0, start, "第一次就扣到 0 不能被写回满分")
}
