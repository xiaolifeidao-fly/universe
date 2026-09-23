package management

import (
	"context"
	"sort"
	"strings"

	"common/middleware/httpx"
	bizlinedto "service/bizline/dto"

	"github.com/gin-gonic/gin"
)

// SpaceDirectory 是空间注册表在移动端需要的那一小块：列出启用的空间。
// 用窄接口而不是整个 bizline.Service，是因为移动端只读这一件事，
// 而 nil 实现要能退化成「按 token 里的授权范围列编码」。
type SpaceDirectory interface {
	List(ctx context.Context) ([]bizlinedto.BizLineView, error)
}

// SpaceView 是移动端空间切换器的一行。
type SpaceView struct {
	Code      string `json:"code"`
	Name      string `json:"name"`
	CanWrite  bool   `json:"canWrite"`
	CanManage bool   `json:"canManage"`
}

// listSpaces 返回当前用户能进的空间。移动端在登录后不再让用户手输业务线编码，
// 而是从这里选：输错一个编码的代价是登录后满屏「无权访问该空间」。
func (h *Handler) listSpaces(c *gin.Context) {
	principal, ok := httpx.CurrentUser(c)
	if !ok {
		httpx.Fail(c, "not login")
		return
	}
	views := make([]SpaceView, 0, len(principal.BizLines))
	if h.spaces != nil {
		defs, err := h.spaces.List(c.Request.Context())
		if err != nil {
			httpx.JSON(c, nil, err)
			return
		}
		for _, def := range defs {
			if !httpx.CanAccessBizLine(c, def.Code) {
				continue
			}
			canManage := httpx.CanManageBizLine(c, def.Code)
			// 不可见的空间只对本空间管理员露出，和控制台一致。
			if !def.Visible && !canManage {
				continue
			}
			views = append(views, SpaceView{
				Code: def.Code, Name: displayName(def.Name, def.Code),
				CanWrite: httpx.CanWriteBizLine(c, def.Code), CanManage: canManage,
			})
		}
		httpx.JSON(c, views, nil)
		return
	}
	// 没有注册表时退化成 token 里的授权范围：显示名就是编码本身。
	seen := map[string]bool{}
	for _, code := range append(append([]string{}, principal.BizLines...), principal.ManagedBizLines...) {
		code = strings.TrimSpace(code)
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		views = append(views, SpaceView{
			Code: code, Name: code,
			CanWrite: httpx.CanWriteBizLine(c, code), CanManage: httpx.CanManageBizLine(c, code),
		})
	}
	sort.Slice(views, func(i, j int) bool { return views[i].Code < views[j].Code })
	httpx.JSON(c, views, nil)
}

func displayName(name, code string) string {
	if trimmed := strings.TrimSpace(name); trimmed != "" {
		return trimmed
	}
	return code
}
