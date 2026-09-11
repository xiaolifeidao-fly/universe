package galaxy

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"testing"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"contract"
)

// 这组用例只盯 Submit 等不等、等多久：池里没有接得了的贡献要立刻 503，
// 贡献只是忙才排队。放置之外的落库走一个什么都不存的库。

const submitMaxWait = 3 * time.Second

func TestSubmitFailsFastWhenNothingCanServe(t *testing.T) {
	haikuOnly := healthy("c1", time.Now())
	haikuOnly.ModelsAllow = []string{"claude-haiku-*"}
	cases := []struct {
		name string
		lane []ContributionSnapshot
	}{
		{"车道里没人", nil},
		{"模型没人提供", []ContributionSnapshot{haikuOnly}},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			started := time.Now()
			_, err := submitService(t, &fakePlane{lane: item.lane}).Submit(context.Background(), relayUnit())
			var cause *contract.UnitError
			if !errors.As(err, &cause) || cause.Code != contract.CodeNoCapacity {
				t.Fatalf("期望 no_capacity，实际 %v", err)
			}
			if elapsed := time.Since(started); elapsed > time.Second {
				t.Fatalf("等不来的请求挂了 %s 才返回", elapsed)
			}
		})
	}
}

func TestSubmitWaitsForBusyContribution(t *testing.T) {
	started := time.Now()
	plane := &fakePlane{
		lane:      []ContributionSnapshot{healthy("c1", started)},
		busyUntil: started.Add(500 * time.Millisecond),
	}
	placement, err := submitService(t, plane).Submit(context.Background(), relayUnit())
	if err != nil {
		t.Fatalf("贡献忙完就能接，不该失败：%v", err)
	}
	if placement.CID != "c1" {
		t.Fatalf("应放置到 c1，实际 %q", placement.CID)
	}
	if elapsed := time.Since(started); elapsed < 500*time.Millisecond {
		t.Fatalf("贡献还忙着就放置成功了（%s）", elapsed)
	}
}

// 绑定着的消费者自己占着一个座位，按座位算那台机器是满的。忙完之后仍要回到它身上，
// 而不是因为「座位满了」被当成等不来直接 503。
func TestSubmitWaitsForBusyBoundContribution(t *testing.T) {
	started := time.Now()
	bound := healthy("c1", started)
	bound.SeatsUsed = bound.Seats
	plane := &fakePlane{
		lane: []ContributionSnapshot{bound}, bound: "c1",
		busyUntil: started.Add(500 * time.Millisecond),
	}
	placement, err := submitService(t, plane).Submit(context.Background(), relayUnit())
	if err != nil {
		t.Fatalf("绑定的贡献忙完就能接，不该失败：%v", err)
	}
	if placement.CID != "c1" {
		t.Fatalf("应回到绑定的 c1，实际 %q", placement.CID)
	}
	if elapsed := time.Since(started); elapsed < 500*time.Millisecond {
		t.Fatalf("贡献还忙着就放置成功了（%s）", elapsed)
	}
}

func relayUnit() contract.WorkUnit {
	unit := contract.WorkUnit{
		Kind: "llm.chat", KindVersion: 1, Provider: "claude_oauth", Model: "claude-sonnet-4-5", ConsumerKey: "ck_1",
	}
	unit.Metering.Estimate = contract.Metering{contract.UnitOutputTokens: 4096}
	return unit
}

func submitService(t *testing.T, plane *fakePlane) Service {
	t.Helper()
	database, err := gorm.Open(mysql.New(mysql.Config{
		Conn: sql.OpenDB(discardDriver{}), SkipInitializeWithVersion: true,
	}), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return New(database, Ports{Control: plane}, NewKindRegistry(relaySpec()), Config{MaxWait: submitMaxWait})
}

// fakePlane 只实现放置路径要用的几样。其余方法没覆盖，被调到就 panic ——
// 那说明放置走到了用例没料到的地方。
type fakePlane struct {
	ControlPlane
	lane  []ContributionSnapshot
	bound string
	// busyUntil 之前读到的快照并发都是满的。
	busyUntil time.Time
}

func (f *fakePlane) read(snapshot ContributionSnapshot) ContributionSnapshot {
	if time.Now().Before(f.busyUntil) {
		snapshot.Inflight = snapshot.Concurrency()
	}
	return snapshot
}

func (f *fakePlane) LookupBinding(context.Context, string, string) (string, bool, error) {
	return f.bound, f.bound != "", nil
}

func (f *fakePlane) GetContribution(_ context.Context, cid string) (ContributionSnapshot, bool, error) {
	for _, snapshot := range f.lane {
		if snapshot.CID == cid {
			return f.read(snapshot), true, nil
		}
	}
	return ContributionSnapshot{}, false, nil
}

func (f *fakePlane) ListLaneContributions(context.Context, string) ([]ContributionSnapshot, error) {
	snapshots := make([]ContributionSnapshot, 0, len(f.lane))
	for _, snapshot := range f.lane {
		snapshots = append(snapshots, f.read(snapshot))
	}
	return snapshots, nil
}

func (f *fakePlane) Place(context.Context, PlaceCommand) (PlaceOutcome, error) {
	return PlaceOutcome{Placed: true}, nil
}

// discardDriver 一个什么都不存的库：写一律成功，查一律空结果。
type discardDriver struct{}

func (d discardDriver) Open(string) (driver.Conn, error)             { return discardConn{}, nil }
func (d discardDriver) Connect(context.Context) (driver.Conn, error) { return discardConn{}, nil }
func (d discardDriver) Driver() driver.Driver                        { return d }

type discardConn struct{}

func (discardConn) Prepare(string) (driver.Stmt, error) { return discardStmt{}, nil }
func (discardConn) Close() error                        { return nil }
func (discardConn) Begin() (driver.Tx, error)           { return discardConn{}, nil }
func (discardConn) Commit() error                       { return nil }
func (discardConn) Rollback() error                     { return nil }

type discardStmt struct{}

func (discardStmt) Close() error                               { return nil }
func (discardStmt) NumInput() int                              { return -1 }
func (discardStmt) Exec([]driver.Value) (driver.Result, error) { return driver.RowsAffected(0), nil }
func (discardStmt) Query([]driver.Value) (driver.Rows, error)  { return discardRows{}, nil }

type discardRows struct{}

func (discardRows) Columns() []string         { return nil }
func (discardRows) Close() error              { return nil }
func (discardRows) Next([]driver.Value) error { return io.EOF }
