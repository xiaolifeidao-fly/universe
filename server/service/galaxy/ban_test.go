package galaxy

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

const bannedFingerprint = "5f0b6c2e9a7d4e18b3c1f0a2d6e9b7c45f0b6c2e9a7d4e18b3c1f0a2d6e9b7c4"

var cleanFingerprint = strings.Repeat("ab", 32)

func TestReportedOtherMachine(t *testing.T) {
	node := &repository.GalaxyNode{NodeID: "n_laptop", MachineFingerprint: cleanFingerprint}
	cases := []struct {
		name     string
		reported string
		want     string
	}{
		{"报的就是记录上那台", cleanFingerprint, ""},
		{"大小写不同不算换了机器", strings.ToUpper(cleanFingerprint), ""},
		{"没报", "", ""},
		{"报得不合格当没报", "node:n_laptop", ""},
		{"令牌被拷到了另一台", bannedFingerprint, bannedFingerprint},
		{"另一台报得不规整也认得出", " " + strings.ToUpper(bannedFingerprint) + "\n", bannedFingerprint},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if got := reportedOtherMachine(node, item.reported); got != item.want {
				t.Fatalf("reportedOtherMachine(%q) = %q，期望 %q", item.reported, got, item.want)
			}
		})
	}
}

func TestBanNodeRejectsBlankNodeBeforeTouchingTheRepository(t *testing.T) {
	// 校验在碰库之前：service 上没有仓储，走到查库就会空指针崩。
	if err := (&service{}).BanNode(context.Background(), dto.BanNodeRequest{NodeID: "  ", Banned: true}); err == nil {
		t.Fatal("没有 nodeId 的封禁应当被拒")
	}
}

// 报过指纹的节点封的是设备：同一台设备上别的账号配出来的记录一起标上、一起清场，
// 封禁表先于节点写（顺序的理由见 repository.SetMachineBanned）。
func TestBanNodeBansEveryRecordOnTheDevice(t *testing.T) {
	svc, db, plane := banHarness(t, map[string]scriptedTable{
		"zt_galaxy_node": nodeRows(
			[]driver.Value{"n_mac", "u_1", bannedFingerprint, "active", false},
			[]driver.Value{"n_other_account", "u_2", bannedFingerprint, "offline", false},
		),
	})
	err := svc.BanNode(context.Background(), dto.BanNodeRequest{NodeID: "n_mac", Banned: true, Reason: "伪造响应", UpdatedBy: "m_admin"})
	if err != nil {
		t.Fatalf("ban: %v", err)
	}
	banAt, nodesAt := db.writeIndex("INSERT INTO `zt_galaxy_machine_ban`"), db.writeIndex("UPDATE `zt_galaxy_node` SET `banned`")
	if banAt < 0 || nodesAt < banAt {
		t.Fatalf("应当先写封禁表、再改节点：%v", db.writes)
	}
	for _, want := range []string{bannedFingerprint, "伪造响应", "m_admin"} {
		if !strings.Contains(db.writes[banAt], want) {
			t.Fatalf("封禁表那一行缺了 %s：%s", want, db.writes[banAt])
		}
	}
	if !strings.Contains(db.writes[nodesAt], "machine_fingerprint = ?") || strings.Contains(db.writes[nodesAt], "node_id = ?") {
		t.Fatalf("节点要按设备改，不是只改点的那一条：%s", db.writes[nodesAt])
	}
	if got := strings.Join(plane.dropped, ","); got != "n_mac,n_other_account" {
		t.Fatalf("同一台设备上的记录都要摘出控制面，实际 %q", got)
	}
	for _, nodeID := range []string{"n_mac", "n_other_account"} {
		if db.writeIndex("UPDATE `zt_galaxy_contribution`", nodeID) < 0 {
			t.Fatalf("%s 的贡献没关：%v", nodeID, db.writes)
		}
	}
}

// 没报过指纹的老节点认不出是哪台设备：只封它自己那一行，一个字都不能碰指纹。
// 按空指纹去改，就是把所有老节点一起封了。
func TestBanNodeWithoutFingerprintOnlyBansThatRecord(t *testing.T) {
	svc, db, plane := banHarness(t, map[string]scriptedTable{
		"zt_galaxy_node": nodeRows([]driver.Value{"n_legacy", "u_1", nil, "active", false}),
	})
	if err := svc.BanNode(context.Background(), dto.BanNodeRequest{NodeID: "n_legacy", Banned: true}); err != nil {
		t.Fatalf("ban: %v", err)
	}
	if at := db.writeIndex("UPDATE `zt_galaxy_node` SET `banned`", "node_id = ?", "n_legacy"); at < 0 {
		t.Fatalf("老节点应当按 nodeId 封：%v", db.writes)
	}
	for _, statement := range append(append([]string{}, db.writes...), db.queries...) {
		if strings.Contains(statement, "zt_galaxy_machine_ban") || strings.Contains(statement, "machine_fingerprint = ?") {
			t.Fatalf("老节点的封禁不该碰设备：%s", statement)
		}
	}
	if got := strings.Join(plane.dropped, ","); got != "n_legacy" {
		t.Fatalf("只摘这一台，实际 %q", got)
	}
}

// 解封放开整台设备，但不替主人把贡献打开，也不再去关一遍、摘一遍。
func TestUnbanClearsTheDeviceButLeavesGrantsAlone(t *testing.T) {
	svc, db, plane := banHarness(t, map[string]scriptedTable{
		"zt_galaxy_node": nodeRows([]driver.Value{"n_mac", "u_1", bannedFingerprint, "active", true}),
	})
	if err := svc.BanNode(context.Background(), dto.BanNodeRequest{NodeID: "n_mac", Banned: false, UpdatedBy: "m_admin"}); err != nil {
		t.Fatalf("unban: %v", err)
	}
	if at := db.writeIndex("INSERT INTO `zt_galaxy_machine_ban`", bannedFingerprint, " false "); at < 0 {
		t.Fatalf("封禁表那一行应当改成 false，不是删掉：%v", db.writes)
	}
	if at := db.writeIndex("UPDATE `zt_galaxy_node` SET `banned`", "machine_fingerprint = ?", "[false "); at < 0 {
		t.Fatalf("整台设备上的记录都要放开：%v", db.writes)
	}
	if len(plane.dropped) != 0 || db.writeIndex("zt_galaxy_contribution") >= 0 {
		t.Fatalf("解封不该动控制面和贡献：dropped=%v writes=%v", plane.dropped, db.writes)
	}
}

func TestBanNodeUnknownNodeWritesNothing(t *testing.T) {
	svc, db, plane := banHarness(t, map[string]scriptedTable{})
	if err := svc.BanNode(context.Background(), dto.BanNodeRequest{NodeID: "n_gone", Banned: true}); err == nil {
		t.Fatal("找不到的机器应当报错，不能静默成功")
	}
	if len(db.writes) != 0 || len(plane.dropped) != 0 {
		t.Fatalf("找不到的机器什么都不该写：writes=%v dropped=%v", db.writes, plane.dropped)
	}
}

// 被封的机器解绑重配出一条新记录：hello 先补指纹、再按封禁表补标，读回来是封禁就到此为止 ——
// 能力清单一行不落，节点不登记进控制面（banPlane 上没实现的方法被调到会 panic）。
func TestHelloOnBannedDeviceStopsBeforeInventory(t *testing.T) {
	svc, db, plane := banHarness(t, map[string]scriptedTable{
		"zt_galaxy_consent_record": consented(),
		// 读回来已经是封禁：前面那条补标语句命中了。
		"zt_galaxy_node": nodeRows([]driver.Value{"n_repaired", "u_3", bannedFingerprint, "active", true}),
	})
	_, err := svc.Hello(context.Background(), dto.HelloRequest{
		NodeID: "n_repaired", OwnerUserID: "u_3", Contract: svc.config.ContractVersion, MachineFingerprint: bannedFingerprint,
		Contributions: []dto.ContributionInput{{CID: "claude-main", Kind: "llm.relay", Provider: "anthropic"}},
	})
	if !errors.Is(err, contract.ErrNodeBanned) {
		t.Fatalf("被封设备上的 hello 应当回 ErrNodeBanned，实际 %v", err)
	}
	fillAt, flagAt := db.writeIndex("machine_fingerprint IS NULL OR machine_fingerprint = ''"), db.writeIndex("machine_fingerprint IN (SELECT")
	if fillAt < 0 || flagAt < fillAt {
		t.Fatalf("应当先补指纹、再按封禁表补标：%v", db.writes)
	}
	for _, forbidden := range []string{"INSERT INTO `zt_galaxy_contribution`", "`available`=", "INSERT INTO `zt_galaxy_node`"} {
		if at := db.writeIndex(forbidden); at >= 0 {
			t.Fatalf("被拒的 hello 不该写 %s：%s", forbidden, db.writes[at])
		}
	}
	if got := strings.Join(plane.dropped, ","); got != "n_repaired" {
		t.Fatalf("被标上的记录要顺手清场，实际 %q", got)
	}
}

// 把一台干净机器的令牌拷到被封的机器上：hello 报上来的是被封的那台，照样拒；
// 但记录代表的是干净的那台，不标它、也不清它的场。
func TestHelloFromCopiedTokenOnBannedDeviceIsRefused(t *testing.T) {
	svc, db, plane := banHarness(t, map[string]scriptedTable{
		"zt_galaxy_consent_record": consented(),
		"zt_galaxy_node":           nodeRows([]driver.Value{"n_laptop", "u_1", cleanFingerprint, "active", false}),
		"zt_galaxy_machine_ban":    {columns: []string{"machine_fingerprint"}, rows: [][]driver.Value{{bannedFingerprint}}},
	})
	_, err := svc.Hello(context.Background(), dto.HelloRequest{
		NodeID: "n_laptop", OwnerUserID: "u_1", Contract: svc.config.ContractVersion, MachineFingerprint: bannedFingerprint,
	})
	if !errors.Is(err, contract.ErrNodeBanned) {
		t.Fatalf("报上来的设备被封了应当拒，实际 %v", err)
	}
	if at := db.queryIndex("FROM `zt_galaxy_machine_ban`", bannedFingerprint); at < 0 {
		t.Fatalf("应当查的是报上来的那台设备：%v", db.queries)
	}
	for _, write := range db.writes {
		if strings.Contains(write, "SET `banned`") && !strings.Contains(write, "machine_fingerprint IN (SELECT") {
			t.Fatalf("记录上的设备没被封，不该标它：%s", write)
		}
	}
	if len(plane.dropped) != 0 || db.writeIndex("zt_galaxy_contribution") >= 0 {
		t.Fatalf("记录上那台机器的贡献不该被清：dropped=%v writes=%v", plane.dropped, db.writes)
	}
}

// 没被封的机器照常过闸，而且不多查一次封禁表：报的和记录上一样、老版本不报、报得不合格，
// 都没有第二台设备需要查。
func TestRefuseBannedMachineLetsCleanDevicesThrough(t *testing.T) {
	cases := []struct {
		name     string
		stored   driver.Value
		reported string
	}{
		{"同一台设备", cleanFingerprint, cleanFingerprint},
		{"老版本不报指纹", nil, ""},
		{"报得不合格", cleanFingerprint, "not-a-fingerprint"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			svc, db, plane := banHarness(t, map[string]scriptedTable{
				"zt_galaxy_node": nodeRows([]driver.Value{"n_1", "u_1", item.stored, "active", false}),
				// 封禁表里摆了一行：真被查到就会拒，用例就能看出多查了。
				"zt_galaxy_machine_ban": {columns: []string{"machine_fingerprint"}, rows: [][]driver.Value{{bannedFingerprint}}},
			})
			if err := svc.refuseBannedMachine(context.Background(), "n_1", item.reported); err != nil {
				t.Fatalf("干净的机器应当放行，实际 %v", err)
			}
			if at := db.queryIndex("zt_galaxy_machine_ban"); at >= 0 {
				t.Fatalf("没有第二台设备要查，却查了封禁表：%s", db.queries[at])
			}
			if len(plane.dropped) != 0 {
				t.Fatalf("干净的机器不该被清场：%v", plane.dropped)
			}
		})
	}
}

// 鉴权和 hello 拦下封禁的机器回的是同一个错，节点侧看到的是同一种结果；撤销是另一回事。
func TestAuthenticateNodeRefusesBannedWithTheSharedError(t *testing.T) {
	svc, _, _ := banHarness(t, map[string]scriptedTable{
		"zt_galaxy_node": nodeRows([]driver.Value{"n_mac", "u_1", bannedFingerprint, "active", true}),
	})
	if _, err := svc.AuthenticateNode(context.Background(), "Bearer gnt_token"); !errors.Is(err, contract.ErrNodeBanned) {
		t.Fatalf("封禁的节点应当回 ErrNodeBanned，实际 %v", err)
	}
	svc, _, _ = banHarness(t, map[string]scriptedTable{
		"zt_galaxy_node": nodeRows([]driver.Value{"n_mac", "u_1", bannedFingerprint, "revoked", false}),
	})
	if _, err := svc.AuthenticateNode(context.Background(), "Bearer gnt_token"); err == nil || errors.Is(err, contract.ErrNodeBanned) {
		t.Fatalf("撤销的节点照旧拒，但不是封禁：%v", err)
	}
}

// ---------- 假库 ----------

// banHarness 一个走真 GORM 的 service：库是按表应答的假库，控制面只认 DropNode。
func banHarness(t *testing.T, tables map[string]scriptedTable) (*service, *scriptedDB, *banPlane) {
	t.Helper()
	db := &scriptedDB{tables: tables}
	database, err := gorm.Open(mysql.New(mysql.Config{
		Conn: sql.OpenDB(db), SkipInitializeWithVersion: true,
	}), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	plane := &banPlane{}
	return New(database, Ports{Control: plane}, nil, DefaultConfig()).(*service), db, plane
}

// banPlane 只实现封禁要用的 DropNode。其余方法没覆盖，被调到就 panic ——
// hello 被拒之后还去登记节点、推快照，就会在这里炸出来。
type banPlane struct {
	ControlPlane
	dropped []string
	// cancelled 强制取消工单时写进来的单号（adminaudit_test.go 用）。
	cancelled []string
}

func (p *banPlane) DropNode(_ context.Context, nodeID string) error {
	p.dropped = append(p.dropped, nodeID)
	return nil
}

func (p *banPlane) RequestCancel(_ context.Context, rid, _ string) error {
	p.cancelled = append(p.cancelled, rid)
	return nil
}

// nodeRows 节点表的几行，列依次是 nodeId、主人、指纹、状态、是否封禁。
func nodeRows(rows ...[]driver.Value) scriptedTable {
	return scriptedTable{columns: []string{"node_id", "owner_user_id", "machine_fingerprint", "status", "banned"}, rows: rows}
}

// consented 同意记录表里有一行：hello 要先过条款同意那一关。
func consented() scriptedTable {
	return scriptedTable{columns: []string{"id"}, rows: [][]driver.Value{{int64(1)}}}
}

// scriptedDB 按表应答的假库：写语句连同绑定值抄下来，查询按 FROM 后面的表名给摆好的行。
//
// 封禁要验的是顺序和范围 —— 先写封禁表再改节点、老节点不碰指纹、hello 被拒时一行能力清单都不落。
// submit_test.go 的 discardDriver 查什么都是空的，走不到这些分支。
type scriptedDB struct {
	mu      sync.Mutex
	tables  map[string]scriptedTable
	writes  []string
	queries []string
}

type scriptedTable struct {
	columns []string
	rows    [][]driver.Value
}

func (db *scriptedDB) Connect(context.Context) (driver.Conn, error) { return scriptedConn{db}, nil }
func (db *scriptedDB) Driver() driver.Driver                        { return db }
func (db *scriptedDB) Open(string) (driver.Conn, error)             { return scriptedConn{db}, nil }

// writeIndex 第一条同时含有这几段文字的写语句的下标，没有就是 -1。
func (db *scriptedDB) writeIndex(needles ...string) int { return indexOfAll(db.writes, needles) }

func (db *scriptedDB) queryIndex(needles ...string) int { return indexOfAll(db.queries, needles) }

func indexOfAll(statements []string, needles []string) int {
next:
	for index, statement := range statements {
		for _, needle := range needles {
			if !strings.Contains(statement, needle) {
				continue next
			}
		}
		return index
	}
	return -1
}

// answer 不看 WHERE：每个用例只摆它要的那几行。SELECT * 给整行，count(*) 给行数，
// Pluck 那种单列查询只给那一列。
func (db *scriptedDB) answer(query string) driver.Rows {
	from := strings.Index(query, " FROM `")
	rest := query[from+len(" FROM `"):]
	table := db.tables[rest[:strings.Index(rest, "`")]]
	selected := strings.TrimSpace(strings.TrimPrefix(query[:from], "SELECT "))
	switch {
	case strings.HasPrefix(selected, "count("):
		return &scriptedRows{columns: []string{"count"}, rows: [][]driver.Value{{int64(len(table.rows))}}}
	case selected == "*":
		return &scriptedRows{columns: table.columns, rows: table.rows}
	}
	column := strings.Trim(selected, "`")
	projected := &scriptedRows{columns: []string{column}}
	for index, name := range table.columns {
		if name != column {
			continue
		}
		for _, row := range table.rows {
			projected.rows = append(projected.rows, []driver.Value{row[index]})
		}
	}
	return projected
}

type scriptedConn struct{ db *scriptedDB }

func (c scriptedConn) Prepare(query string) (driver.Stmt, error) {
	return scriptedStmt{c.db, query}, nil
}
func (c scriptedConn) Close() error              { return nil }
func (c scriptedConn) Begin() (driver.Tx, error) { return c, nil }
func (c scriptedConn) Commit() error             { return nil }
func (c scriptedConn) Rollback() error           { return nil }

type scriptedStmt struct {
	db    *scriptedDB
	query string
}

func (s scriptedStmt) Close() error  { return nil }
func (s scriptedStmt) NumInput() int { return -1 }

func (s scriptedStmt) Exec(args []driver.Value) (driver.Result, error) {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	s.db.writes = append(s.db.writes, fmt.Sprintf("%s %v", s.query, args))
	// 影响行数给 0：给了非 0，GORM 建行后会去要自增 id，而这个假库给不出来。
	return driver.RowsAffected(0), nil
}

func (s scriptedStmt) Query(args []driver.Value) (driver.Rows, error) {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	s.db.queries = append(s.db.queries, fmt.Sprintf("%s %v", s.query, args))
	return s.db.answer(s.query), nil
}

type scriptedRows struct {
	columns []string
	rows    [][]driver.Value
	next    int
}

func (r *scriptedRows) Columns() []string { return r.columns }
func (r *scriptedRows) Close() error      { return nil }

func (r *scriptedRows) Next(dest []driver.Value) error {
	if r.next >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.next])
	r.next++
	return nil
}
