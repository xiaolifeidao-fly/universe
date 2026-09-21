package repository

import (
	"context"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

// insertColumns 抄下一条 INSERT 的列名顺序，用来按列找它绑了什么值。
var insertColumns = regexp.MustCompile("INSERT INTO `\\w+` \\((.*?)\\) VALUES")

// TestCreateConsumerKeyWritesNullNoticeAck 盯住注册送的那把密钥签不出来。
//
// 注册即送的密钥背后没有一次数据告知确认，notice_ack_at 要留 NULL。这一列是
// `timestamp NULL DEFAULT NULL`：模型上写成非指针的 time.Time 时，零值会被原样
// 当成 '0000-00-00 00:00:00' 发出去，撞上 NO_ZERO_DATE 就是 1292 —— 于是
// 「注册送一把」在严格模式的库上一把也签不出来，而本地宽松模式看不出任何异常。
func TestCreateConsumerKeyWritesNullNoticeAck(t *testing.T) {
	repository, pool := recordingRepository(t)
	now := time.Now()
	// 这个池子不真的执行，取不回自增主键，所以 Create 必然带着错误回来。
	// 要看的是下发出去的那条 INSERT 给 notice_ack_at 绑了什么。
	_ = repository.CreateConsumerKey(context.Background(), &GalaxyConsumerKey{
		BizLine: "galaxy", KeyID: "ck_1", KeyHash: "hash", OwnerUserID: "cu_1",
		Alias: "默认密钥", Status: "active", IssuedAt: now, ExpiresAt: now.Add(time.Hour),
	})
	if len(pool.statements) == 0 {
		t.Fatal("一条语句都没有下发")
	}
	index := len(pool.statements) - 1
	columns := insertColumns.FindStringSubmatch(pool.statements[index])
	if columns == nil {
		t.Fatalf("最后一条不是 INSERT：%s", pool.statements[index])
	}
	position := -1
	for at, column := range strings.Split(columns[1], ",") {
		if strings.Trim(strings.TrimSpace(column), "`") == "notice_ack_at" {
			position = at
			break
		}
	}
	if position < 0 {
		t.Fatalf("INSERT 里没有 notice_ack_at：%s", columns[1])
	}
	// 绑过去的是 (*time.Time)(nil)：接口值不是 nil，但 database/sql 会把空指针转成
	// NULL。所以这里要判「是不是空指针」，光比 nil 会把它当成一个真的时间放过去。
	value := pool.args[index][position]
	if pointer := reflect.ValueOf(value); value != nil && !(pointer.Kind() == reflect.Pointer && pointer.IsNil()) {
		t.Fatalf("没有确认过告知的密钥，notice_ack_at 要写 NULL，实际绑的是 %v", value)
	}
}
