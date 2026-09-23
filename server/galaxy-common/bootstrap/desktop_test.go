package bootstrap

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// 更新目录这一条是**发不发得出更新**的唯一入口：界面拿它补上端那一段再回给壳，
// 错一个字符就是客户端 404，而 404 的表现是「安静地不更新」，没有任何人会收到告警。
func TestRegisterDesktopServesFeedBase(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct{ name, base string }{
		{"配了对象存储就回 <publicHost>/<dirPrefix>", "https://galaxy-un.oss-cn-hongkong.aliyuncs.com/galaxy"},
		{"没配就回空串 —— 这个部署不检查更新，不是故障", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			engine := gin.New()
			RegisterDesktop(engine.Group("/api/galaxy"), tc.base)
			recorder := httptest.NewRecorder()
			engine.ServeHTTP(recorder, httptest.NewRequest("GET", "/api/galaxy/desktop/update-feed", nil))
			// 两种情况都是 200：回 4xx 会让界面把它当错误画出来，而用户对此无能为力。
			if recorder.Code != 200 {
				t.Fatalf("状态码不是 200：%d", recorder.Code)
			}
			var body struct {
				Success bool `json:"success"`
				Data    struct {
					UpdateFeed string `json:"updateFeed"`
				} `json:"data"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatalf("响应不是合法 JSON：%v", err)
			}
			if !body.Success || body.Data.UpdateFeed != tc.base {
				t.Fatalf("更新目录不对：%#v", body)
			}
		})
	}
}
