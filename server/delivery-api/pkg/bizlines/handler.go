// Package bizlines 提供业务线选择与管理接口。
package bizlines

import (
	"fmt"
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
	group.GET("/bizline/lines", httpx.RequireUserOrService(), h.list)
	api := group.Group("/bizline", httpx.RequireUser())
	api.GET("/lines/all", h.listAll)
	api.POST("/line/save", h.save)
	api.POST("/line/delete", h.delete)

	// 成员只能自助加入、由空间管理员剔除，所以没有整体覆盖式的成员分配接口。
	api.GET("/line/members", h.members)
	api.POST("/line/member/permission", h.saveMemberPermission)
	api.POST("/line/member/remove", h.removeMember)

	api.POST("/line/share", h.createShareLink)
	api.GET("/share", h.resolveShareLink)
	api.POST("/share/join", h.joinByShareLink)
}

func (h *Handler) list(context *gin.Context) {
	views, err := h.service.List(context.Request.Context())
	if err == nil {
		views = forCaller(context, views)
	}
	httpx.JSON(context, views, err)
}

func (h *Handler) listAll(context *gin.Context) {
	views, err := h.service.ListAll(context.Request.Context())
	if err == nil {
		views = forCaller(context, views)
	}
	httpx.JSON(context, views, err)
}

// save 建空间对所有登录用户开放，创建人即这个空间的管理员 ——
// 系统管理员不再隐式可见所有空间，少了这一步，新建出来的空间会立刻成为没人能进的孤儿。
// 空间编码是全局唯一的，所以编码已存在时一律按「改已有空间」处理，
// 不能管理它的人改不动，也就不存在拿别人的编码顶掉别人空间的路径。
func (h *Handler) save(context *gin.Context) {
	var req bizlinedto.SaveBizLineRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	code := strings.ToLower(strings.TrimSpace(req.Code))
	current, getErr := h.service.Get(context.Request.Context(), code)
	creating := getErr != nil
	actorID, hasActor := callerUserID(context)
	if creating {
		if !h.allowMoreBizLines(context) {
			return
		}
		// 创建者随空间一起落库：后面剔除成员时要拿它挡住把创建者移出空间。
		req.CreatedBy = actorID
	} else {
		if !httpx.CanManageBizLine(context, code) {
			// 看得到这个空间的人是在改它；看不到的人是想用一个已被占用的编码建新空间。
			if httpx.CanAccessBizLine(context, code) {
				httpx.Fail(context, "无权修改该空间")
			} else {
				httpx.Fail(context, "空间编码已被占用")
			}
			return
		}
		// 重新启用等同于再占一个名额，否则停用再启用就能绕过配额。
		if req.Enabled && !current.Enabled && !h.allowMoreBizLines(context) {
			return
		}
	}
	if err := h.service.Save(context.Request.Context(), req); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	if creating {
		if hasActor {
			if err := h.identities.SaveBizLineMember(context.Request.Context(), identitydto.BizLineMemberRequest{
				BizLine: code, UserID: actorID, CanWrite: true, AsManager: true,
			}); err != nil {
				httpx.JSON(context, nil, err)
				return
			}
		}
	}
	httpx.JSON(context, nil, nil)
}

// allowMoreBizLines 校验建空间配额：一个用户名下最多 30 个启用的空间。
// 只算启用项，所以删除或停用一个就能继续建 —— 停用的空间不占名额。
func (h *Handler) allowMoreBizLines(context *gin.Context) bool {
	principal, ok := httpx.CurrentUser(context)
	if !ok {
		httpx.Fail(context, "not login")
		return false
	}
	owned, err := h.service.CountEnabledOwned(context.Request.Context(), principal.ManagedBizLines)
	if err != nil {
		httpx.JSON(context, nil, err)
		return false
	}
	if owned >= bizlinedto.MaxOwnedBizLines {
		httpx.Fail(context, fmt.Sprintf("最多只能拥有 %d 个启用的空间，请先删除或停用不再使用的空间", bizlinedto.MaxOwnedBizLines))
		return false
	}
	return true
}

// delete 交给空间管理员：系统管理员看不到别人的空间，再把删除锁死在它身上，
// 空间就没人能清理了。
func (h *Handler) delete(context *gin.Context) {
	var req bizlinedto.DeleteBizLineRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !httpx.CanManageBizLine(context, strings.ToLower(strings.TrimSpace(req.Code))) {
		httpx.Fail(context, "无权删除空间")
		return
	}
	httpx.JSON(context, nil, h.service.Delete(context.Request.Context(), req))
}

// ---------- 成员 ----------

// members 是「查看成员」面板和项目成员候选的共同数据源：
// 项目成员只能从本空间已有成员里挑，所以两边看的是同一份名单。
func (h *Handler) members(context *gin.Context) {
	bizLine := strings.TrimSpace(context.Query("bizLine"))
	if err := httpx.AuthorizeBizLine(context, bizLine); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	views, err := h.identities.ListBizLineMembers(context.Request.Context(), bizLine)
	httpx.JSON(context, views, err)
}

func (h *Handler) saveMemberPermission(context *gin.Context) {
	var req identitydto.BizLineMemberRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !httpx.CanManageBizLine(context, strings.TrimSpace(req.BizLine)) {
		httpx.Fail(context, "无权调整该空间成员权限")
		return
	}
	// 调权是管理别人的动作。自己给自己降级等于顺手交出这个空间的管理权，
	// 和剔除自己是同一类误操作 —— 要放弃管理权请让另一位管理员来做。
	if actorID, ok := callerUserID(context); ok && actorID == req.UserID {
		httpx.Fail(context, "不能调整自己的权限")
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
	if !httpx.CanManageBizLine(context, strings.TrimSpace(req.BizLine)) {
		httpx.Fail(context, "无权剔除该空间成员")
		return
	}
	// 剔除是管理别人的动作。把自己踢出去等于顺手交出这个空间的管理权，
	// 而且极易误点 —— 要退出请让另一位管理员来做。
	if actorID, ok := callerUserID(context); ok && actorID == req.UserID {
		httpx.Fail(context, "不能把自己移出空间")
		return
	}
	// 空间创建者一律留下：后来被授予管理权的人不该能把建这个空间的人清出去。
	line, err := h.service.Get(context.Request.Context(), strings.ToLower(strings.TrimSpace(req.BizLine)))
	if err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	if line.CreatedBy > 0 && line.CreatedBy == req.UserID {
		httpx.Fail(context, "不能把空间创建者移出空间")
		return
	}
	httpx.JSON(context, nil, h.identities.RemoveBizLineMember(context.Request.Context(), req.BizLine, req.UserID))
}

// ---------- 分享链接 ----------

func (h *Handler) createShareLink(context *gin.Context) {
	var req bizlinedto.CreateShareLinkRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !httpx.CanManageBizLine(context, strings.ToLower(strings.TrimSpace(req.BizLine))) {
		httpx.Fail(context, "无权分享该空间")
		return
	}
	req.CreatedBy = httpx.CallerID(context)
	view, err := h.service.CreateShareLink(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

// resolveShareLink 是受邀人点开链接后的预览：空间描述加上这条链接给的权限。
// 已经是成员的人也能打开，前端据此把「确认加入」换成已加入提示。
func (h *Handler) resolveShareLink(context *gin.Context) {
	target, err := h.service.ResolveShareLink(context.Request.Context(), context.Query("token"))
	if err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	response := struct {
		bizlinedto.ShareLinkTarget
		Joined bool `json:"joined"`
	}{ShareLinkTarget: target}
	if actorID, ok := callerUserID(context); ok {
		joined, memberErr := h.identities.IsBizLineMember(context.Request.Context(), target.BizLine, actorID)
		if memberErr != nil {
			httpx.JSON(context, nil, memberErr)
			return
		}
		response.Joined = joined
	}
	httpx.JSON(context, response, nil)
}

// joinByShareLink 是加入空间的唯一入口。已是成员的人重复点不会掉权限：
// 已有的管理员或写入身份不能被一条只读链接降级。
func (h *Handler) joinByShareLink(context *gin.Context) {
	var req struct {
		Token string `json:"token"`
	}
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	target, err := h.service.ResolveShareLink(context.Request.Context(), req.Token)
	if err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	actorID, ok := callerUserID(context)
	if !ok {
		httpx.Fail(context, "用户标识无效")
		return
	}
	members, err := h.identities.ListBizLineMembers(context.Request.Context(), target.BizLine)
	if err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	member := identitydto.BizLineMemberRequest{
		BizLine:  target.BizLine,
		UserID:   actorID,
		CanWrite: target.Permission == bizlinedto.PermissionWrite,
	}
	for _, existing := range members {
		if existing.ID == actorID {
			member.AsManager = existing.IsManager
			member.CanWrite = member.CanWrite || existing.CanWrite
			break
		}
	}
	if err := h.identities.SaveBizLineMember(context.Request.Context(), member); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	httpx.JSON(context, target, nil)
}

// forCaller 一次做两件事：落实空间的隐私开关，并给每一行盖上调用者自己的权限。
//
// 不可见的空间只对本空间管理员出现在列表里，它自己的普通成员也看不到。
// 权限随行返回是有意的 —— 前端不该拿浏览器里缓存的授权范围去猜自己能不能改，
// 那份缓存在别人调整权限、或换个标签页登录之后就不准了。
func forCaller(context *gin.Context, views []bizlinedto.BizLineView) []bizlinedto.BizLineView {
	filtered := views[:0]
	for _, view := range views {
		if !httpx.CanAccessBizLine(context, view.Code) {
			continue
		}
		view.CanManage = httpx.CanManageBizLine(context, view.Code)
		view.CanWrite = httpx.CanWriteBizLine(context, view.Code)
		if !view.Visible && !view.CanManage {
			continue
		}
		filtered = append(filtered, view)
	}
	return filtered
}

func callerUserID(context *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(httpx.CallerID(context), 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}

var _ routers.Handler = (*Handler)(nil)
