package repository

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const testFingerprint = "5f0b6c2e9a7d4e18b3c1f0a2d6e9b7c45f0b6c2e9a7d4e18b3c1f0a2d6e9b7c4"

// TestSetMachineBannedWritesBanBeforeNodes 盯住两条语句的顺序和范围。
//
// 顺序反了，hello 补指纹恰好夹在两条中间的那台新节点谁都标不到（见 SetMachineBanned 的注释）；
// 节点那条少了指纹条件，封一台就是封全池。两种写法都照样返回 nil。
func TestSetMachineBannedWritesBanBeforeNodes(t *testing.T) {
	repository, pool := recordingRepository(t)
	err := repository.SetMachineBanned(context.Background(), &GalaxyMachineBan{
		BizLine: "galaxy", MachineFingerprint: testFingerprint, Banned: true, Reason: "伪造响应", UpdatedBy: "m_admin",
	})
	if err != nil {
		t.Fatalf("ban: %v", err)
	}
	if len(pool.statements) != 2 {
		t.Fatalf("期望先写封禁表、再改节点两条，实际 %d 条：%v", len(pool.statements), pool.statements)
	}
	ban, nodes := recorded(pool, 0), recorded(pool, 1)
	for _, want := range []string{"INSERT INTO `zt_galaxy_machine_ban`", testFingerprint, "伪造响应", "m_admin",
		"ON DUPLICATE KEY UPDATE", "`banned`=VALUES(`banned`)", "`reason`=VALUES(`reason`)", "`updated_by`=VALUES(`updated_by`)"} {
		if !strings.Contains(ban, want) {
			t.Fatalf("第一条应当是封禁表的 upsert，缺了 %s：%s", want, ban)
		}
	}
	for _, want := range []string{"UPDATE `zt_galaxy_node` SET `banned`", "biz_line = ?", "machine_fingerprint = ?", testFingerprint} {
		if !strings.Contains(nodes, want) {
			t.Fatalf("第二条应当按设备改节点，缺了 %s：%s", want, nodes)
		}
	}
}

// TestUnbanWritesFalseInBothPlaces 解封写的是零值 false，两条语句里都得真的带着它。
//
// INSERT 里少了 banned 列，或者节点那条被当成「没改什么」省掉，解封都会静静地成功，机器却还连不上。
func TestUnbanWritesFalseInBothPlaces(t *testing.T) {
	repository, pool := recordingRepository(t)
	if err := repository.SetMachineBanned(context.Background(), &GalaxyMachineBan{
		BizLine: "galaxy", MachineFingerprint: testFingerprint, Banned: false, UpdatedBy: "m_admin",
	}); err != nil {
		t.Fatalf("unban: %v", err)
	}
	if len(pool.statements) != 2 {
		t.Fatalf("解封也是两条语句，实际 %d 条：%v", len(pool.statements), pool.statements)
	}
	if insert := pool.statements[0]; !strings.Contains(insert[:strings.Index(insert, "ON DUPLICATE KEY UPDATE")], "`banned`,") {
		t.Fatalf("INSERT 里没有 banned 列：%s", insert)
	}
	if !containsArg(pool.args[0], false) {
		t.Fatalf("封禁表的 upsert 没带上 false：%v", pool.args[0])
	}
	if !containsArg(pool.args[1], false) {
		t.Fatalf("节点那条没把 banned 改回 false：%s", recorded(pool, 1))
	}
}

// TestSetMachineBannedRefusesEmptyFingerprint 空指纹一条语句都不许发。
//
// 老节点的 machine_fingerprint 是空的：按空串去改节点行，一次封禁就把所有没报过指纹的机器全封了。
func TestSetMachineBannedRefusesEmptyFingerprint(t *testing.T) {
	repository, pool := recordingRepository(t)
	for _, banned := range []bool{true, false} {
		err := repository.SetMachineBanned(context.Background(), &GalaxyMachineBan{BizLine: "galaxy", Banned: banned})
		if err == nil {
			t.Fatalf("banned=%v：空指纹应当报错", banned)
		}
	}
	if len(pool.statements) != 0 {
		t.Fatalf("空指纹不该下发任何语句：%v", pool.statements)
	}
}

// TestBanNodeIfMachineBannedStaysOnThatNode hello 时的补标只能落在这一条记录上，而且判断得在同一条语句里。
func TestBanNodeIfMachineBannedStaysOnThatNode(t *testing.T) {
	repository, pool := recordingRepository(t)
	if err := repository.BanNodeIfMachineBanned(context.Background(), "galaxy", "n_new"); err != nil {
		t.Fatalf("flag: %v", err)
	}
	if len(pool.statements) != 1 {
		t.Fatalf("判断和标记应当是同一条语句，实际 %d 条：%v", len(pool.statements), pool.statements)
	}
	statement := recorded(pool, 0)
	for _, want := range []string{"UPDATE `zt_galaxy_node` SET `banned`", "node_id = ?", "n_new",
		"machine_fingerprint IN (SELECT `machine_fingerprint` FROM `zt_galaxy_machine_ban`", "banned = ?"} {
		if !strings.Contains(statement, want) {
			t.Fatalf("语句里缺了 %s：%s", want, statement)
		}
	}
	// 绑定值的头一个是 SET 的 banned，最后一个是子查询里的 banned 条件：两个都得是 true。
	if args := pool.args[0]; args[0] != true || args[len(args)-1] != true {
		t.Fatalf("补标要写 true，子查询也只认封禁中的行：%s", statement)
	}
}

// TestNodeIDsByFingerprintSkipsRevokedAndEmpty 封禁时要逐台清场的节点：同一台设备、还没撤销。
func TestNodeIDsByFingerprintSkipsRevokedAndEmpty(t *testing.T) {
	repository, pool := queryRecordingRepository(t)
	_, _ = repository.NodeIDsByFingerprint(context.Background(), "galaxy", testFingerprint)
	statement := lastStatement(t, &pool.recordingPool)
	for _, want := range []string{"SELECT `node_id` FROM `zt_galaxy_node`", "biz_line = ?", "machine_fingerprint = ?", testFingerprint, "status <> ?", "revoked"} {
		if !strings.Contains(statement, want) {
			t.Fatalf("语句里缺了 %s：%s", want, statement)
		}
	}

	repository, pool = queryRecordingRepository(t)
	ids, err := repository.NodeIDsByFingerprint(context.Background(), "galaxy", "")
	if err != nil || len(ids) != 0 || len(pool.statements) != 0 {
		t.Fatalf("空指纹不该查库，那会捞出全部老节点：ids=%v err=%v statements=%v", ids, err, pool.statements)
	}
}

// TestMachineBannedOnlyCountsActiveBans 解封过的行还留着，只有 banned 为真的才算封禁中。
func TestMachineBannedOnlyCountsActiveBans(t *testing.T) {
	repository, pool := queryRecordingRepository(t)
	_, _ = repository.MachineBanned(context.Background(), "galaxy", testFingerprint)
	statement := lastStatement(t, &pool.recordingPool)
	for _, want := range []string{"FROM `zt_galaxy_machine_ban`", "machine_fingerprint = ?", testFingerprint, "banned = ?"} {
		if !strings.Contains(statement, want) {
			t.Fatalf("语句里缺了 %s：%s", want, statement)
		}
	}
	if !containsArg(pool.args[len(pool.args)-1], true) {
		t.Fatalf("只该数封禁中的行：%s", statement)
	}

	repository, pool = queryRecordingRepository(t)
	banned, err := repository.MachineBanned(context.Background(), "galaxy", "")
	if err != nil || banned || len(pool.statements) != 0 {
		t.Fatalf("空指纹不算封禁，也不查库：banned=%v err=%v statements=%v", banned, err, pool.statements)
	}
}

// TestMachineBanOnMySQL 在真 MySQL 上跑封禁的几条语句。设置了 GALAXY_TEST_DSN 才跑：
//
//	GALAXY_TEST_DSN='user:pass@tcp(host:3306)/db?parseTime=True&loc=Local' go test ./service/galaxy/internal/repository/ -run OnMySQL
//
// 录下来的 SQL 证明不了 MySQL 怎么求值：子查询里的封禁表认不认得出、空指纹和 NULL 的老节点会不会被带上、
// 解封之后补标还会不会命中。
//
// 和 TestAdjustReputationOnMySQL 一样只碰会话级临时表，用一条钉死的连接：临时表只对建它的那条连接可见。
func TestMachineBanOnMySQL(t *testing.T) {
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
	for _, ddl := range []string{
		"CREATE TEMPORARY TABLE `zt_galaxy_node` (" +
			"`id` bigint AUTO_INCREMENT, `biz_line` varchar(32), `node_id` varchar(64), `owner_user_id` varchar(64), " +
			"`machine_fingerprint` varchar(64), `status` varchar(16), `banned` boolean DEFAULT false, " +
			"`created_time` datetime(3) NULL, `updated_time` datetime(3) NULL, " +
			"PRIMARY KEY (`id`), UNIQUE INDEX `uk_gx_node_id` (`biz_line`,`node_id`), " +
			"INDEX `idx_gx_node_fingerprint` (`biz_line`,`machine_fingerprint`))",
		"CREATE TEMPORARY TABLE `zt_galaxy_machine_ban` (" +
			"`id` bigint AUTO_INCREMENT, `biz_line` varchar(32), `machine_fingerprint` varchar(64), `banned` boolean, " +
			"`reason` varchar(255), `updated_by` varchar(64), `created_time` datetime(3) NULL, `updated_time` datetime(3) NULL, " +
			"PRIMARY KEY (`id`), UNIQUE INDEX `uk_gx_machine_ban_fingerprint` (`biz_line`,`machine_fingerprint`))",
	} {
		if err := database.Exec(ddl).Error; err != nil {
			t.Fatalf("建临时表: %v", err)
		}
	}
	// 往里写之前确认两张都是临时表：哪天有人删掉一个 TEMPORARY，这条测试不能去改真表。
	for _, name := range []string{"zt_galaxy_node", "zt_galaxy_machine_ban"} {
		var table, ddl string
		if err := database.Raw("SHOW CREATE TABLE `"+name+"`").Row().Scan(&table, &ddl); err != nil || !strings.HasPrefix(ddl, "CREATE TEMPORARY TABLE") {
			t.Fatalf("%s 不是临时表，停下：%v %s", name, err, ddl)
		}
	}

	other := strings.Repeat("ab", 32)
	// n_legacy_null 的指纹是 NULL，n_legacy_empty 是空串：老节点两种都有，哪种都不能被按设备带上。
	if err := database.Exec("INSERT INTO `zt_galaxy_node` (`biz_line`,`node_id`,`owner_user_id`,`machine_fingerprint`,`status`,`banned`) VALUES "+
		"('galaxy','n_mac','u_1',?,'active',false),"+
		"('galaxy','n_other_account','u_2',?,'offline',false),"+
		"('galaxy','n_retired','u_1',?,'revoked',false),"+
		"('galaxy','n_legacy_null','u_1',NULL,'active',false),"+
		"('galaxy','n_legacy_empty','u_1','','active',false),"+
		"('galaxy','n_elsewhere','u_1',?,'active',false)",
		testFingerprint, testFingerprint, testFingerprint, other).Error; err != nil {
		t.Fatalf("插节点: %v", err)
	}

	repository := &GalaxyRepository{}
	repository.SetDb(database)
	bannedNodes := func() []string {
		t.Helper()
		var ids []string
		if err := database.Model(&GalaxyNode{}).Where("banned = ?", true).Pluck("node_id", &ids).Error; err != nil {
			t.Fatalf("读封禁节点: %v", err)
		}
		// 在 Go 里排，不靠 ORDER BY：库的排序规则和 sort.Strings 不一定一致。
		sort.Strings(ids)
		return ids
	}
	expectBanned := func(why string, want ...string) {
		t.Helper()
		sort.Strings(want)
		if got := bannedNodes(); strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("%s：期望被封 %v，实际 %v", why, want, got)
		}
	}
	expectMachine := func(fingerprint string, want bool, why string) {
		t.Helper()
		got, err := repository.MachineBanned(ctx, "galaxy", fingerprint)
		if err != nil || got != want {
			t.Fatalf("%s：MachineBanned(%q) = %v, %v，期望 %v", why, fingerprint, got, err, want)
		}
	}
	setBanned := func(banned bool, reason string) {
		t.Helper()
		if err := repository.SetMachineBanned(ctx, &GalaxyMachineBan{
			BizLine: "galaxy", MachineFingerprint: testFingerprint, Banned: banned, Reason: reason, UpdatedBy: "m_admin",
		}); err != nil {
			t.Fatalf("SetMachineBanned(%v): %v", banned, err)
		}
	}
	flag := func(nodeID string) {
		t.Helper()
		if err := repository.BanNodeIfMachineBanned(ctx, "galaxy", nodeID); err != nil {
			t.Fatalf("BanNodeIfMachineBanned(%s): %v", nodeID, err)
		}
	}

	setBanned(true, "伪造响应")
	expectBanned("同一台设备上的记录一起封，包括别的账号和撤销掉的；老节点和别的设备不受牵连",
		"n_mac", "n_other_account", "n_retired")
	expectMachine(testFingerprint, true, "封禁中")
	expectMachine(other, false, "别的设备没被封")
	ids, err := repository.NodeIDsByFingerprint(ctx, "galaxy", testFingerprint)
	sort.Strings(ids)
	if err != nil || strings.Join(ids, ",") != "n_mac,n_other_account" {
		t.Fatalf("要清场的节点应当是没撤销的那两台，实际 %v, %v", ids, err)
	}

	// 被封的机器解绑重配出一条新记录，hello 补上指纹之后补标。
	if err := database.Exec("INSERT INTO `zt_galaxy_node` (`biz_line`,`node_id`,`owner_user_id`,`machine_fingerprint`,`status`,`banned`) VALUES ('galaxy','n_repaired','u_3',?,'active',false)",
		testFingerprint).Error; err != nil {
		t.Fatalf("插重配节点: %v", err)
	}
	for _, nodeID := range []string{"n_repaired", "n_elsewhere", "n_legacy_null", "n_legacy_empty"} {
		flag(nodeID)
	}
	expectBanned("hello 补标只命中被封设备上的新记录", "n_mac", "n_other_account", "n_repaired", "n_retired")

	setBanned(false, "误封")
	expectBanned("解封把这台设备上的记录全部放开")
	expectMachine(testFingerprint, false, "解封之后行还在，但不算封禁中")
	flag("n_repaired")
	expectBanned("解封之后再 hello 不能被补标回去")

	var rows []*GalaxyMachineBan
	if err := database.Where("machine_fingerprint = ?", testFingerprint).Find(&rows).Error; err != nil || len(rows) != 1 {
		t.Fatalf("同一台设备封了又解只该有一行：%d 行, %v", len(rows), err)
	}
	if rows[0].Banned || rows[0].Reason != "误封" || rows[0].UpdatedBy != "m_admin" {
		t.Fatalf("那一行记的应当是最近一次操作：%+v", rows[0])
	}
}

// recorded 第 index 条下发出去的语句，连同绑定值拼成一行，同 lastStatement。
func recorded(pool *recordingPool, index int) string {
	return fmt.Sprintf("%s %v", pool.statements[index], pool.args[index])
}

func containsArg(args []any, want any) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}
