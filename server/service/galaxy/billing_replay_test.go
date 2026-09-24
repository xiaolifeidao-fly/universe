package galaxy

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"contract"
)

// 结算重放不能重复发钱。
//
// 账本按 (biz_line, txn_id) 幂等，余额却是加减 —— 两者必须绑在一起写。这里钉的是两道闸：
// settle 一发现「这个单元早就结过账了」就整段跳过；就算绕过它直接走到 record，
// 入账也只跟着**真的插进去的**那几行账本走。
//
// 顺带钉住供给侧账本的量纲：那一行记的是积分（分成之后的钱），不是 token 数。
// 记成 token 数的话，收益页上「今天赚了多少」加的是 token、「可提现」用的是余额里的钱，
// 两个口径根本不是一个东西。

// 一次执行：1000 个输出 token，单价 15,000,000（每百万单位的微元），分成 0.7。
// 成本 = 1000 × 15,000,000 ÷ 1,000,000 = 15,000，提供者那份 = 10,500。
const (
	replayTokens        int64 = 1000
	replayPrice         int64 = 15_000_000
	replayProviderShare       = 0.7
	replayCredit        int64 = 10_500
)

func TestReplayedSettleWritesNothingASecondTime(t *testing.T) {
	plane := &replayPlane{settled: true}
	service, database := billingHarness(t, plane)
	runtime := replayRuntime()
	usage := contract.Metering{contract.UnitOutputTokens: replayTokens}

	if err := service.settle(context.Background(), runtime, contract.KindSpec{}, usage, contract.UnitCompleted, true, nil); err != nil {
		t.Fatalf("第一次结算失败：%v", err)
	}
	if got := database.count("zt_galaxy_credit_account"); got != 1 {
		t.Fatalf("第一次结算应当入账一次，实际 %d 次", got)
	}
	if got := database.count("zt_galaxy_provider_ledger"); got != 1 {
		t.Fatalf("第一次结算应当写一行供给侧账本，实际 %d 行", got)
	}

	// 控制面说「这个单元早就结过账了」：整段计费都不该再走一遍。
	plane.settled = false
	before := database.len()
	if err := service.settle(context.Background(), runtime, contract.KindSpec{}, usage, contract.UnitCompleted, true, nil); err != nil {
		t.Fatalf("重放的结算不该报错：%v", err)
	}
	if after := database.len(); after != before {
		t.Fatalf("重放又写了 %d 条语句，一条都不该写", after-before)
	}
}

// 供给侧账本记的是分成之后的积分，不是计量数。
func TestProviderLedgerRecordsCreditsNotMeteredAmount(t *testing.T) {
	service, database := billingHarness(t, &replayPlane{settled: true})
	usage := contract.Metering{contract.UnitOutputTokens: replayTokens}

	if err := service.record(context.Background(), replayRuntime(), contract.KindSpec{}, usage, true); err != nil {
		t.Fatalf("结算失败：%v", err)
	}

	provider := database.argsOf(t, "zt_galaxy_provider_ledger")
	if !containsValue(provider, replayCredit) {
		t.Fatalf("供给侧账本里应当是积分 %d，实际绑定值：%v", replayCredit, provider)
	}
	if containsValue(provider, replayTokens) {
		t.Fatalf("供给侧账本里不该出现计量数 %d（那是 zt_galaxy_meter_record 的事）", replayTokens)
	}
	// 消费侧那一行相反：它回答的是「用了多少」，所以记的就是计量数。
	// 「扣了多少钱」是另一张表（见 billing_charge_test.go）。
	consumerLedger := database.argsOf(t, "zt_galaxy_consumer_ledger")
	if !containsValue(consumerLedger, replayTokens) {
		t.Fatalf("消费侧账本应当记用量 %d，实际绑定值：%v", replayTokens, consumerLedger)
	}
}

// 第二道闸：账本没插进去（这笔之前就记过），余额一分都不能动。
func TestCreditOnlyFollowsLedgerRowsThatWereActuallyInserted(t *testing.T) {
	service, database := billingHarness(t, &replayPlane{settled: true})
	database.duplicateLedger = true
	usage := contract.Metering{contract.UnitOutputTokens: replayTokens}

	if err := service.record(context.Background(), replayRuntime(), contract.KindSpec{}, usage, true); err != nil {
		t.Fatalf("结算失败：%v", err)
	}
	if got := database.count("zt_galaxy_credit_account"); got != 0 {
		t.Fatalf("账本撞了唯一键就不该入账，实际入账 %d 次", got)
	}
	// 使用者那边同理，只是护栏长得不一样：改余额和记流水在同一个事务里，
	// 流水撞了唯一键就整个事务回滚，余额那一笔跟着作废。
	if database.rollbacks == 0 {
		t.Fatal("积分流水撞了唯一键，扣款事务必须回滚")
	}
}

func replayRuntime() UnitRuntime {
	return UnitRuntime{
		RID: "u_replay", CID: "n_1:claude", ConsumerKey: "ck_1",
		Kind: "llm.chat", Provider: "claude_oauth", Attempt: 1,
		Estimate: contract.Metering{contract.UnitOutputTokens: replayTokens},
	}
}

// billingHarness 一个走真 GORM 的 service：库是下面那个记账的假库，
// 控制面只实现 Settle —— 结算路径上用到的就它一个。
func billingHarness(t *testing.T, plane ControlPlane) (*service, *billingDB) {
	t.Helper()
	store := &billingDB{
		tables: map[string][][]driver.Value{
			// 定价：一行就够，kind 与 unit 要和用例里的对得上。
			"zt_galaxy_price": {{"llm.chat", string(contract.UnitOutputTokens), replayPrice, "CNY", replayProviderShare, time.Now().Add(-time.Hour)}},
			// 贡献：结算要从它身上取 owner。
			"zt_galaxy_contribution": {{"n_1:claude", "n_1", "pu_owner"}},
			// 密钥：扣费要从它身上取「这把是谁的」，钱从那个人的余额里扣。
			"zt_galaxy_consumer_key": {{"ck_1", "cu_buyer"}},
			// 账户：改完余额要回读一次 balance_after 记进流水。
			"zt_galaxy_points_account": {{"cu_buyer", int64(1_000_000)}},
		},
		columns: map[string][]string{
			"zt_galaxy_price":          {"kind", "unit", "price", "currency", "provider_share", "effective_from"},
			"zt_galaxy_contribution":   {"cid", "node_id", "owner_user_id"},
			"zt_galaxy_consumer_key":   {"key_id", "owner_user_id"},
			"zt_galaxy_points_account": {"owner_user_id", "balance"},
		},
	}
	database, err := gorm.Open(mysql.New(mysql.Config{
		Conn: sql.OpenDB(store), SkipInitializeWithVersion: true,
	}), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return New(database, Ports{Control: plane}, nil, DefaultConfig()).(*service), store
}

// replayPlane 只实现 Settle。settled=false 模拟「这个单元之前就结过账了」。
type replayPlane struct {
	ControlPlane
	settled bool
}

func (p *replayPlane) Settle(context.Context, SettleCommand) (bool, error) { return p.settled, nil }

// billingDB 一个把写语句连同绑定值抄下来的假库：查询按表名给摆好的行。
//
// 和 ban_test.go 的 scriptedDB 分开写，是因为这里要断言的是**绑定值**（记进账本的是
// 积分还是 token 数），而那边只留了语句文本。
type billingDB struct {
	mu      sync.Mutex
	tables  map[string][][]driver.Value
	columns map[string][]string
	writes  []billingWrite
	// queries 抄下来的查询语句。取价那条要钉住：它每笔计费都走一遍，
	// 而「走不走得上索引」只看 WHERE 和 ORDER BY 长什么样。
	queries []string
	// duplicateLedger 为真时账本插入报「0 行受影响」，也就是撞了唯一键。
	duplicateLedger bool
	// rollbacks 事务回滚了几次。
	rollbacks int
}

type billingWrite struct {
	sql  string
	args []driver.Value
}

func (db *billingDB) Connect(context.Context) (driver.Conn, error) { return billingConn{db}, nil }
func (db *billingDB) Driver() driver.Driver                        { return db }
func (db *billingDB) Open(string) (driver.Conn, error)             { return billingConn{db}, nil }

func (db *billingDB) len() int {
	db.mu.Lock()
	defer db.mu.Unlock()
	return len(db.writes)
}

// count 写到某张表上的语句条数。
func (db *billingDB) count(table string) int {
	db.mu.Lock()
	defer db.mu.Unlock()
	total := 0
	for _, write := range db.writes {
		if strings.Contains(write.sql, table) {
			total++
		}
	}
	return total
}

// argsOf 第一条写到某张表上的语句的绑定值。
func (db *billingDB) argsOf(t *testing.T, table string) []driver.Value {
	t.Helper()
	db.mu.Lock()
	defer db.mu.Unlock()
	for _, write := range db.writes {
		if strings.Contains(write.sql, table) {
			return write.args
		}
	}
	t.Fatalf("没有写到 %s 的语句", table)
	return nil
}

// writesTo 写到某张表上的全部语句的绑定值，按发生顺序。
func (db *billingDB) writesTo(table string) [][]driver.Value {
	db.mu.Lock()
	defer db.mu.Unlock()
	var out [][]driver.Value
	for _, write := range db.writes {
		if strings.Contains(write.sql, table) {
			out = append(out, write.args)
		}
	}
	return out
}

// queryOf 第一条读某张表的语句。
func (db *billingDB) queryOf(t *testing.T, table string) string {
	t.Helper()
	db.mu.Lock()
	defer db.mu.Unlock()
	for _, query := range db.queries {
		if strings.Contains(query, table) {
			return query
		}
	}
	t.Fatalf("没有读 %s 的语句", table)
	return ""
}

func containsValue(args []driver.Value, want int64) bool {
	for _, arg := range args {
		if value, ok := arg.(int64); ok && value == want {
			return true
		}
	}
	return false
}

type billingConn struct{ db *billingDB }

func (c billingConn) Prepare(query string) (driver.Stmt, error) {
	return billingStmt{db: c.db, query: query}, nil
}
func (c billingConn) Close() error              { return nil }
func (c billingConn) Begin() (driver.Tx, error) { return billingTx{db: c.db}, nil }

// billingTx 只记「回滚过没有」。假库照抄每一条写语句、不真的撤销，
// 所以「事务回滚了」这件事本身就是唯一能断言的痕迹 —— 而扣钱那条路
// 正是靠回滚来保证重放不会多扣一笔。
type billingTx struct{ db *billingDB }

func (t billingTx) Commit() error { return nil }

func (t billingTx) Rollback() error {
	t.db.mu.Lock()
	defer t.db.mu.Unlock()
	t.db.rollbacks++
	return nil
}

type billingStmt struct {
	db    *billingDB
	query string
}

func (s billingStmt) Close() error  { return nil }
func (s billingStmt) NumInput() int { return -1 }

func (s billingStmt) Exec(args []driver.Value) (driver.Result, error) {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	s.db.writes = append(s.db.writes, billingWrite{sql: s.query, args: args})
	if s.db.duplicateLedger && strings.Contains(s.query, "_ledger") {
		// 撞了唯一键：ON DUPLICATE KEY UPDATE id=id 什么也没改，受影响行数是 0。
		return billingResult{}, nil
	}
	return billingResult{affected: 1}, nil
}

// billingResult GORM 建行之后会去问自增主键，driver.RowsAffected 答不了这个问题。
type billingResult struct{ affected int64 }

func (r billingResult) LastInsertId() (int64, error) { return 1, nil }
func (r billingResult) RowsAffected() (int64, error) { return r.affected, nil }

func (s billingStmt) Query([]driver.Value) (driver.Rows, error) {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	s.db.queries = append(s.db.queries, s.query)
	from := strings.Index(s.query, " FROM ")
	if from < 0 {
		return &billingRows{}, nil
	}
	rest := strings.Fields(s.query[from+len(" FROM "):])
	table := strings.Trim(rest[0], "`")
	return &billingRows{columns: s.db.columns[table], rows: s.db.tables[table]}, nil
}

type billingRows struct {
	columns []string
	rows    [][]driver.Value
	cursor  int
}

func (r *billingRows) Columns() []string { return r.columns }
func (r *billingRows) Close() error      { return nil }
func (r *billingRows) Next(dest []driver.Value) error {
	if r.cursor >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.cursor])
	r.cursor++
	return nil
}
