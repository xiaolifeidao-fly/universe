package repository

import (
	"context"
	"strings"
	"testing"
)

// TestRevokeProviderKeyKeepsHash 盯住一把吊不掉的密钥。
//
// key_hash 上挂着 (biz_line, key_hash) 的唯一索引。吊销时顺手把它清空，
// 第一把还吊得掉，第二把就去抢第一把留下的那个 ('galaxy','')，MySQL 回 1062，
// 主人在控制台点「吊销」只看到一行红字，而那把该停的密钥还活着。
// 单元测试里连不上真库，看不见 1062 —— 能看见的是这条 UPDATE 到底动了哪几列。
func TestRevokeProviderKeyKeepsHash(t *testing.T) {
	repository, pool := recordingRepository(t)
	// 这个池子对每条 UPDATE 都答「影响 0 行」，于是必然拿到 ErrRecordNotFound。
	// 要看的是下发出去的那条语句，不是它的返回值。
	_ = repository.RevokeProviderKey(context.Background(), "galaxy", "u_owner", "gpk_1")
	statement := lastStatement(t, pool)
	if strings.Contains(statement, "key_hash") {
		t.Fatalf("吊销不能碰 key_hash，唯一索引在这一列上：%s", statement)
	}
	for _, want := range []string{"biz_line = ?", "owner_user_id = ?", "u_owner", "key_id = ?", "gpk_1", "revoked"} {
		if !strings.Contains(statement, want) {
			t.Fatalf("语句里缺了 %s：%s", want, statement)
		}
	}
}
