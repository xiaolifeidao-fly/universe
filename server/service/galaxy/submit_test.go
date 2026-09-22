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
	otherGroup := healthy("c1", time.Now())
	otherGroup.Groups = []string{"mg_DEEP"}
	cases := []struct {
		name string
		lane []ContributionSnapshot
	}{
		{"车道里没人", nil},
		{"这个分组没人加入", []ContributionSnapshot{otherGroup}},
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

// 余量下限必须在**每一条**放置路径上成立，不只在硬过滤里。
//
// 绑定那条是九成请求走的路（「上次落在哪台就先敲那台的门」），只在硬过滤里判的话，
// 主人划的线就只拦得住生客：老客户照样一单一单地把他留给自己的那部分跑光，
// 而共享设置页上一切正常。
func TestSubmitBoundPathHonoursUpstreamFloor(t *testing.T) {
	now := time.Now()
	held := healthy("c1", now)
	held.UpstreamFloors = []UpstreamFloor{{Percent: 20}}
	held.UpstreamLeft = map[string]UpstreamLeft{"7d": {Percent: 5, Bucket: "Current week (all models)"}}
	plane := &fakePlane{lane: []ContributionSnapshot{held, healthy("c2", now)}, bound: "c1"}

	placement, err := submitService(t, plane).Submit(context.Background(), relayUnit())
	if err != nil {
		t.Fatalf("还有一台没到线的机器，这一单该落到它身上：%v", err)
	}
	if placement.CID != "c2" {
		t.Fatalf("绑定的 c1 已经到线，应改落 c2，实际 %q", placement.CID)
	}
	if !plane.released {
		t.Fatal("到线的机器要解绑 —— 它得等上游窗口重置才回来，留着绑定只会每次先敲一次空门")
	}
}

// 带 previous_response_id 的链式请求同样不放行。
//
// 放它过去说得通（是会话的后续回合，不算新单），但那个口子没有边界：
// 一个聊得正欢的会话可以顺着它把主人留给自己的那部分一路跑光。
func TestSubmitHardPinHonoursUpstreamFloor(t *testing.T) {
	now := time.Now()
	held := healthy("c1", now)
	held.UpstreamFloors = []UpstreamFloor{{Percent: 20}}
	held.UpstreamLeft = map[string]UpstreamLeft{"5h": {Percent: 3}}

	unit := relayUnit()
	unit.HardPin = "c1"
	_, err := submitService(t, &fakePlane{lane: []ContributionSnapshot{held}}).Submit(context.Background(), unit)
	var cause *contract.UnitError
	if !errors.As(err, &cause) || cause.Code != contract.CodeNodeUnavailable {
		t.Fatalf("期望 node_unavailable（不能改派），实际 %v", err)
	}
}

// 全池都到线时立刻 503，不要干等到 maxWait：那台机器要等上游窗口重置才回来，
// 而窗口以小时计，等几秒只是把一个注定的失败往后推。
func TestSubmitFailsFastWhenEveryoneIsHolding(t *testing.T) {
	now := time.Now()
	held := healthy("c1", now)
	held.UpstreamFloors = []UpstreamFloor{{Percent: 50}}
	held.UpstreamLeft = map[string]UpstreamLeft{"5h": {Percent: 12}}

	started := time.Now()
	_, err := submitService(t, &fakePlane{lane: []ContributionSnapshot{held}}).Submit(context.Background(), relayUnit())
	var cause *contract.UnitError
	if !errors.As(err, &cause) || cause.Code != contract.CodeNoCapacity {
		t.Fatalf("期望 no_capacity，实际 %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("等不来的请求挂了 %s 才返回", elapsed)
	}
}

func relayUnit() contract.WorkUnit {
	unit := contract.WorkUnit{
		Kind: "llm.chat", KindVersion: 1, Provider: "claude_oauth",
		Model: "claude-sonnet-4-5", Group: "mg_STD", ConsumerKey: "ck_1",
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
	// released 绑定被解掉过没有。余量到线那条路要解绑，而解不解绑在返回值上
	// 看不出来 —— 两种情况这一单都会落到别的机器上。
	released bool
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

func (f *fakePlane) ReleaseBinding(context.Context, string, string, string) error {
	f.released = true
	return nil
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
