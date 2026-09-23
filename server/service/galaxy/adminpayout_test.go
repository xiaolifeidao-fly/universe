package galaxy

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"strings"
	"testing"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"service/galaxy/dto"
)

// 提现审批盯的全是钱：积分在申请那一刻就扣走了，这一页是它唯一的出口。
// 所以错一步不是「界面不好用」，是那笔钱要么退两次、要么再也回不来。

// TestHandlePayoutRefusesADecisionItDoesNotUnderstand 只认 paid / rejected。
//
// 放过一个别的字符串，单子会被改成一个谁也不认识的状态 —— 它从待办里消失了，
// 但钱既没打出去、也没退回去。
func TestHandlePayoutRefusesADecisionItDoesNotUnderstand(t *testing.T) {
	svc, _, _ := banHarness(t, nil)
	for _, status := range []string{"", "pending", "done", "approve"} {
		_, err := svc.HandlePayout(context.Background(), dto.HandlePayoutRequest{
			PayoutID: "po_1", Status: status, Note: "随便写点",
		})
		if err == nil {
			t.Fatalf("处置结果 %q 应当被拒", status)
		}
	}
}

// TestHandlePayoutMakesYouSayWhyWhenRejecting 驳回必须写原因。
//
// 那段话会原样给到申请人。没有理由的驳回，他只会把同一张单子原样再提一次 ——
// 于是两边都在等对方。
func TestHandlePayoutMakesYouSayWhyWhenRejecting(t *testing.T) {
	svc, _, _ := banHarness(t, nil)
	if _, err := svc.HandlePayout(context.Background(), dto.HandlePayoutRequest{
		PayoutID: "po_1", Status: "rejected", Note: "   ",
	}); err == nil {
		t.Fatal("驳回没写原因应当被拒")
	}
	// 「确认已打款」不要求写说明：钱已经出去了，这一步只是记账。
	if _, err := svc.HandlePayout(context.Background(), dto.HandlePayoutRequest{
		PayoutID: "po_missing", Status: "paid",
	}); err == nil || strings.Contains(err.Error(), "原因") {
		t.Fatalf("确认打款不该卡在「要写原因」上，实际 %v", err)
	}
}

// TestHandlePayoutRefusesOneThatIsAlreadySettled 已经处置过的单子不能再动。
//
// 尤其是「已驳回」再驳回一次 —— 那会把积分退第二遍。
func TestHandlePayoutRefusesOneThatIsAlreadySettled(t *testing.T) {
	for _, status := range []string{"paid", "rejected"} {
		svc, db, _ := payoutHarness(t, payoutRow(status), 1)
		_, err := svc.HandlePayout(context.Background(), dto.HandlePayoutRequest{
			PayoutID: "po_1", Status: "rejected", Note: "重复处置",
		})
		if err == nil {
			t.Fatalf("状态为 %s 的单子不该还能处置", status)
		}
		if db.writeIndex("zt_galaxy_credit_account") >= 0 {
			t.Fatalf("状态为 %s 时不该退积分", status)
		}
	}
}

// TestHandlePayoutDoesNotRefundWhenSomeoneElseGotThereFirst 并发驳回。
//
// 状态更新带 status = 'pending' 的条件，两个运营同时点驳回，后一个改到 0 行。
// 这里就得停住 —— 继续往下走就是把同一笔积分退两次。
func TestHandlePayoutDoesNotRefundWhenSomeoneElseGotThereFirst(t *testing.T) {
	// affected = 0：条件更新一行都没改到，也就是别人抢先处置了。
	svc, db, _ := payoutHarness(t, payoutRow("pending"), 0)
	_, err := svc.HandlePayout(context.Background(), dto.HandlePayoutRequest{
		PayoutID: "po_1", Status: "rejected", Note: "收款账号不对",
	})
	if err == nil {
		t.Fatal("没改到行就该报错，而不是当成处置成功")
	}
	if db.writeIndex("zt_galaxy_credit_account") >= 0 {
		t.Fatal("没改到行却退了积分 —— 这正是同一笔钱被退两次的路径")
	}
}

// TestHandlePayoutRefundsThePointsWhenItRejects 驳回要把积分退回去，并在账本上留痕。
//
// 只退余额不记账本，对账时那笔凭空多出来的余额没人解释得了。
func TestHandlePayoutRefundsThePointsWhenItRejects(t *testing.T) {
	svc, db, _ := payoutHarness(t, payoutRow("pending"), 1)
	if _, err := svc.HandlePayout(context.Background(), dto.HandlePayoutRequest{
		PayoutID: "po_1", Status: "rejected", Note: "收款账号与实名不一致", HandledBy: "m_admin",
	}); err != nil {
		t.Fatalf("驳回应当成功：%v", err)
	}
	if db.writeIndex("zt_galaxy_payout", "pending") < 0 {
		t.Error("状态更新要带 pending 条件，否则并发时会重复处置")
	}
	if db.writeIndex("zt_galaxy_credit_account") < 0 {
		t.Error("驳回要把积分退回账户")
	}
	if db.writeIndex("zt_galaxy_provider_ledger", "payout_refund") < 0 {
		t.Error("退款要在账本上记一笔反向流水")
	}
}

// TestHandlePayoutKeepsThePointsWhenItPaysOut 确认打款不退钱。
//
// 积分在申请时就扣了，这一步只是记下「钱出去了」—— 再退一次等于白送一笔。
func TestHandlePayoutKeepsThePointsWhenItPaysOut(t *testing.T) {
	svc, db, _ := payoutHarness(t, payoutRow("pending"), 1)
	if _, err := svc.HandlePayout(context.Background(), dto.HandlePayoutRequest{
		PayoutID: "po_1", Status: "paid", HandledBy: "m_admin",
	}); err != nil {
		t.Fatalf("确认打款应当成功：%v", err)
	}
	if db.writeIndex("zt_galaxy_credit_account") >= 0 {
		t.Fatal("确认打款不该动积分账户")
	}
}

// ---------- 假库 ----------

// payoutRow 提现表里的一行。列顺序与 payoutTable 的 columns 对应。
func payoutRow(status string) [][]driver.Value {
	return [][]driver.Value{{"po_1", "pu_1", int64(20_000_000), int64(20_000_000), status, "bank", "6222" + "0000"}}
}

// payoutHarness 一个走真 GORM 的 service：提现表摆好一行，写语句的影响行数可控。
//
// 影响行数是这组用例的关键 —— HandlePayout 那条条件更新改到几行，决定了
// 后面退不退积分。banHarness 的假库一律回 0，测不出「改到了」那一半。
func payoutHarness(t *testing.T, rows [][]driver.Value, affected int64) (*service, *scriptedDB, *gorm.DB) {
	t.Helper()
	db := &scriptedDB{tables: map[string]scriptedTable{
		"zt_galaxy_payout": {
			columns: []string{"payout_id", "owner_user_id", "credits", "amount", "status", "method", "account"},
			rows:    rows,
		},
	}}
	database, err := gorm.Open(mysql.New(mysql.Config{
		Conn: sql.OpenDB(&affectingDB{scriptedDB: db, affected: affected}), SkipInitializeWithVersion: true,
	}), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return New(database, Ports{}, nil, DefaultConfig()).(*service), db, database
}

// affectingDB 和 scriptedDB 一模一样，只是写语句回一个可控的影响行数。
type affectingDB struct {
	*scriptedDB
	affected int64
}

func (db *affectingDB) Connect(context.Context) (driver.Conn, error) { return affectingConn{db}, nil }
func (db *affectingDB) Driver() driver.Driver                        { return db }
func (db *affectingDB) Open(string) (driver.Conn, error)             { return affectingConn{db}, nil }

type affectingConn struct{ db *affectingDB }

func (c affectingConn) Prepare(query string) (driver.Stmt, error) {
	return affectingStmt{c.db, scriptedStmt{c.db.scriptedDB, query}}, nil
}
func (c affectingConn) Close() error              { return nil }
func (c affectingConn) Begin() (driver.Tx, error) { return c, nil }
func (c affectingConn) Commit() error             { return nil }
func (c affectingConn) Rollback() error           { return nil }

type affectingStmt struct {
	db    *affectingDB
	inner scriptedStmt
}

func (s affectingStmt) Close() error  { return nil }
func (s affectingStmt) NumInput() int { return -1 }

func (s affectingStmt) Exec(args []driver.Value) (driver.Result, error) {
	if _, err := s.inner.Exec(args); err != nil {
		return nil, err
	}
	return affectingResult{affected: s.db.affected}, nil
}

// affectingResult driver.RowsAffected 不支持 LastInsertId，而 GORM 建完行就去要它。
// 退积分走的是 upsert（Create + OnConflict），不给这个值那一步会直接报错。
type affectingResult struct{ affected int64 }

func (r affectingResult) LastInsertId() (int64, error) { return 1, nil }
func (r affectingResult) RowsAffected() (int64, error) { return r.affected, nil }

func (s affectingStmt) Query(args []driver.Value) (driver.Rows, error) { return s.inner.Query(args) }
