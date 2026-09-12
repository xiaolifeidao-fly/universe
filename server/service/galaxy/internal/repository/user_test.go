package repository

import (
	"context"
	"strings"
	"testing"
	"time"
)

// 账号表分成了两张，这一组测试盯的就是「落错表」这件事。
//
// 它值得单独盯，是因为落错表几乎不会报错：两张表的列一模一样，语句在另一端照样执行，
// 读到的是空、改到的是零行。查一个人查不到，界面上退回显示裸 id；停用一个人改到零行，
// 接口只会说「账号不存在」，而那个人照样登得进来。

const (
	providerTable = "zt_galaxy_provider_user"
	consumerTable = "zt_galaxy_consumer_user"
)

// assertTable 语句必须打在 want 那张表上，而且完全不提另一张。
func assertTable(t *testing.T, statement, want, other string) {
	t.Helper()
	if !strings.Contains(statement, want) {
		t.Fatalf("语句没落在 %s 上：%s", want, statement)
	}
	if strings.Contains(statement, other) {
		t.Fatalf("语句里不该出现 %s：%s", other, statement)
	}
}

// TestUserReadsStayOnTheirSide 两端的读各走各的表。
func TestUserReadsStayOnTheirSide(t *testing.T) {
	cases := []struct {
		side, want, other string
	}{
		{SideProvider, providerTable, consumerTable},
		{SideConsumer, consumerTable, providerTable},
	}
	for _, tc := range cases {
		repository, pool := queryRecordingRepository(t)
		if _, err := repository.FindUser(context.Background(), "galaxy", tc.side, "u_1"); err == nil {
			t.Fatal("只记不执行的池子不该查出行来")
		}
		assertTable(t, lastStatement(t, &pool.recordingPool), tc.want, tc.other)

		repository, pool = queryRecordingRepository(t)
		_, _ = repository.FindUserByName(context.Background(), "galaxy", tc.side, "fly")
		assertTable(t, lastStatement(t, &pool.recordingPool), tc.want, tc.other)

		repository, pool = queryRecordingRepository(t)
		_, _ = repository.ListUsersByIDs(context.Background(), "galaxy", tc.side, []string{"u_1", "u_2"})
		assertTable(t, lastStatement(t, &pool.recordingPool), tc.want, tc.other)

		repository, pool = queryRecordingRepository(t)
		_, _, _ = repository.ListUsers(context.Background(), UserQuery{BizLine: "galaxy", Side: tc.side, Limit: 20})
		assertTable(t, lastStatement(t, &pool.recordingPool), tc.want, tc.other)
	}
}

// TestCreateUserPicksTableBySide 建号看的是 row.Side —— 上层构造的还是同一个 GalaxyUser，
// 端写错就会把一个 cu_ 开头的人建进共享端表里，之后他两边都登不进来。
func TestCreateUserPicksTableBySide(t *testing.T) {
	for side, want := range map[string]string{SideProvider: providerTable, SideConsumer: consumerTable} {
		repository, pool := recordingRepository(t)
		// 只记不执行的池子拿不到自增 id，Create 会带着错误返回；要看的是它下发了什么。
		_ = repository.CreateUser(context.Background(), &GalaxyUser{
			BizLine: "galaxy", Side: side, UserID: "u_1", Username: "fly", Status: "active",
		})
		statement := lastStatement(t, pool)
		if !strings.HasPrefix(strings.ToUpper(statement), "INSERT") {
			t.Fatalf("建号该是一条 INSERT：%s", statement)
		}
		assertTable(t, statement, want, otherTable(want))
		// side 是「这一行来自哪张表」，不是列。写进去的话，AutoMigrate 建的表里根本没有这一列。
		if strings.Contains(statement, "`side`") {
			t.Fatalf("side 不是库里的列，不该出现在 INSERT 里：%s", statement)
		}
	}
}

// TestBumpTokenVersionUpdatesTheRightTableAndTouchesUpdatedTime 停用、重置密码、改密码
// 都走这一条。
//
// 除了表要对，updated_time 也必须跟着变：库里的时间列刻意没有 ON UPDATE
// （20260908_timestamp_no_auto_update），全靠 GORM 按模型定义补。而这里的语句是用
// Table(...) 指定表名的，一旦少了配套的 Model(...)，GORM 没有那份列定义，
// autoUpdateTime 就悄悄不生效——语句照跑，只有更新时间永远停在建号那一刻。
func TestBumpTokenVersionUpdatesTheRightTableAndTouchesUpdatedTime(t *testing.T) {
	for side, want := range map[string]string{SideProvider: providerTable, SideConsumer: consumerTable} {
		repository, pool := recordingRepository(t)
		// 只记不执行的池子答「改了零行」，于是这里回的是「账号不存在」；要看的是它下发了什么。
		_ = repository.BumpTokenVersion(context.Background(), "galaxy", side, "u_1", map[string]any{
			"status": "disabled",
		})
		statement := lastStatement(t, pool)
		assertTable(t, statement, want, otherTable(want))
		for _, fragment := range []string{"token_version", "updated_time", "user_id = ?", "biz_line = ?"} {
			if !strings.Contains(statement, fragment) {
				t.Fatalf("语句里缺了 %s：%s", fragment, statement)
			}
		}
	}
}

func TestTouchUserLoginStaysOnItsSide(t *testing.T) {
	repository, pool := recordingRepository(t)
	if err := repository.TouchUserLogin(context.Background(), "galaxy", SideConsumer, "cu_1", time.Now()); err != nil {
		t.Fatalf("touch: %v", err)
	}
	assertTable(t, lastStatement(t, pool), consumerTable, providerTable)
}

// TestUnknownSideQueriesNothing 端不认识就当场报错，一条语句都不下发。
//
// 退回某一端的话，一个拼错的 side 会安安静静地在共享端里查使用端的人 ——
// 查不到、改零行，报出来的却是「账号不存在」，没人看得出是端传错了。
func TestUnknownSideQueriesNothing(t *testing.T) {
	repository, pool := queryRecordingRepository(t)
	ctx := context.Background()
	if _, err := repository.FindUser(ctx, "galaxy", "", "u_1"); err == nil {
		t.Fatal("空的端该报错")
	}
	if _, err := repository.FindUserByName(ctx, "galaxy", "admin", "fly"); err == nil {
		t.Fatal("不认识的端该报错")
	}
	if err := repository.CreateUser(ctx, &GalaxyUser{BizLine: "galaxy", UserID: "u_1"}); err == nil {
		t.Fatal("没有端的账号建不出来")
	}
	if err := repository.BumpTokenVersion(ctx, "galaxy", "", "u_1", map[string]any{"status": "disabled"}); err == nil {
		t.Fatal("空的端该报错")
	}
	if _, _, err := repository.ListUsers(ctx, UserQuery{BizLine: "galaxy", Limit: 20}); err == nil {
		t.Fatal("不说翻哪一端就该报错")
	}
	if len(pool.statements) != 0 {
		t.Fatalf("端不认识时一条语句都不该下发：%v", pool.statements)
	}
}

// TestConsumerKeywordSubqueryStaysOnConsumers 「按主人搜」积分流水和算力密钥时，
// 拿来匹配用户名的那张表只能是使用端的：这两张表的主人不可能是共享端的人。
func TestConsumerKeywordSubqueryStaysOnConsumers(t *testing.T) {
	repository, pool := queryRecordingRepository(t)
	_, _, _ = repository.ListPointsLedger(context.Background(), PointsLedgerQuery{
		BizLine: "galaxy", OwnerKeyword: "fly", Limit: 20,
	})
	assertTable(t, lastStatement(t, &pool.recordingPool), consumerTable, providerTable)

	repository, pool = queryRecordingRepository(t)
	_, _, _ = repository.ListConsumerKeyPage(context.Background(), ConsumerKeyPageQuery{
		BizLine: "galaxy", Keyword: "fly", Limit: 20,
	})
	assertTable(t, lastStatement(t, &pool.recordingPool), consumerTable, providerTable)
}

func otherTable(table string) string {
	if table == providerTable {
		return consumerTable
	}
	return providerTable
}
