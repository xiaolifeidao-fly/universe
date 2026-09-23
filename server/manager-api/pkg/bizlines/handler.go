// Package bizlines is manager-api's controller layer for business-line
// (space) administration. It reuses service/bizline and service/identity
// exactly like delivery-api/pkg/bizlines does, but with different
// authorization: this is a system-admin console, so every route requires
// the manager-api/auth middleware and skips the ownership/visibility filtering
// delivery-api applies for the collaborative per-space web console (a
// system admin manages every space, not just the ones they created or
// were invited to).
package bizlines

import (
	"strconv"
	"strings"

	"common/middleware/httpx"
	"common/middleware/routers"

	"service/bizline"
	bizlinedto "service/bizline/dto"
	"service/identity"
	identitydto "service/identity/dto"

	"github.com/gin-gonic/gin"
)

type Handler struct {
	service    bizline.Service
	identities identity.Service
}

func NewHandler(service bizline.Service, identities identity.Service) *Handler {
	return &Handler{service: service, identities: identities}
}

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	admin := group.Group("/bizlines")
	// ListAll：管理端要看到全部业务线，包括已停用的——这就是「业务线管理页」
	// 该看到的东西，不是控制台侧边栏那个只列自己能访问的选择器。
	admin.GET("", h.list)
	admin.POST("", h.save)
	admin.POST("/delete", h.delete)

	admin.GET("/members", h.members)
	admin.POST("/member/permission", h.saveMemberPermission)
	admin.POST("/member/remove", h.removeMember)
}

// list 不做 forCaller 那套可见性过滤：系统管理员管的是全部空间，
// 不是「自己是成员或管理员的那些」。CanManage/CanWrite 统一给 true——
// 管理端里这两个字段没有意义，但前端的按钮显隐逻辑（如果照抄了 web 那份）
// 至少不会因为字段缺失而全部隐藏。
func (h *Handler) list(context *gin.Context) {
	views, err := h.service.ListAll(context.Request.Context())
	if err == nil {
		for index := range views {
			views[index].CanManage = true
			views[index].CanWrite = true
		}
	}
	httpx.JSON(context, views, err)
}

// save 管理端建/改空间不受个人配额和「只有本空间管理员能改」的限制——
// 那两条规则是为自助建空间的协作场景设计的，系统管理员不受其约束。
func (h *Handler) save(context *gin.Context) {
	var req bizlinedto.SaveBizLineRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.Code = strings.ToLower(strings.TrimSpace(req.Code))
	_, getErr := h.service.Get(context.Request.Context(), req.Code)
	creating := getErr != nil
	if creating {
		req.CreatedBy, _ = callerUserID(context)
	}
	if err := h.service.Save(context.Request.Context(), req); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	if creating {
		if actorID, ok := callerUserID(context); ok {
			if err := h.identities.SaveBizLineMember(context.Request.Context(), identitydto.BizLineMemberRequest{
				BizLine: req.Code, UserID: actorID, CanWrite: true, AsManager: true,
			}); err != nil {
				httpx.JSON(context, nil, err)
				return
			}
		}
	}
	httpx.JSON(context, nil, nil)
}

func (h *Handler) delete(context *gin.Context) {
	var req bizlinedto.DeleteBizLineRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.Code = strings.ToLower(strings.TrimSpace(req.Code))
	httpx.JSON(context, nil, h.service.Delete(context.Request.Context(), req))
}

func (h *Handler) members(context *gin.Context) {
	code := strings.ToLower(strings.TrimSpace(context.Query("code")))
	views, err := h.identities.ListBizLineMembers(context.Request.Context(), code)
	httpx.JSON(context, views, err)
}

func (h *Handler) saveMemberPermission(context *gin.Context) {
	var req identitydto.BizLineMemberRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	httpx.JSON(context, nil, h.identities.SaveBizLineMember(context.Request.Context(), req))
}

func (h *Handler) removeMember(context *gin.Context) {
	var req identitydto.BizLineMemberRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	httpx.JSON(context, nil, h.identities.RemoveBizLineMember(context.Request.Context(), req.BizLine, req.UserID))
}

func callerUserID(context *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(httpx.CallerID(context), 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}

var _ routers.Handler = (*Handler)(nil)
