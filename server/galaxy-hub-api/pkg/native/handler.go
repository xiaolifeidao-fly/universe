// Package native 提供 /v1 平台原生 SDK 接口，使用算力密钥鉴权。
package native

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	corepkg "galaxy-hub-api/adapters/core"
	"service/galaxy"
	"service/galaxy/dto"
)

type Handler struct{ service galaxy.Service }

func NewHandler(service galaxy.Service) *Handler { return &Handler{service: service} }

// RegisterNative 挂在根路由下，与 relay 的 /v1/messages 同一鉴权。
func (h *Handler) RegisterNative(group *gin.RouterGroup) {
	group.POST("/artifacts", h.signUpload)
	group.GET("/artifacts/*objectKey", h.signDownload)
	group.GET("/usage", h.usage)
	group.GET("/keys/me", h.describeKey)
	// 用当前密钥换发自己这一把。没有「下单」这条路了 —— 额度是账户余额，
	// 充值只能由运营在管理端做。
	group.POST("/keys/:keyId/renew", h.renewKeyWithKey)
}

// ---------- /v1 原生 ----------

type signUploadRequest struct {
	Name        string `json:"name" binding:"required"`
	Size        int64  `json:"size" binding:"required"`
	ContentType string `json:"contentType"`
	Kind        string `json:"kind" binding:"required"`
}

func (h *Handler) signUpload(context *gin.Context) {
	var req signUploadRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		context.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"type": "invalid_body", "message": err.Error()}})
		return
	}
	caller := corepkg.CallerFrom(context)
	ref, err := h.service.SignUpload(context.Request.Context(), req.Kind, req.Name, req.ContentType, req.Size, caller.KeyID)
	if err != nil {
		context.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"type": "artifact_error", "message": err.Error()}})
		return
	}
	context.JSON(http.StatusOK, ref)
}

func (h *Handler) signDownload(context *gin.Context) {
	objectKey := strings.TrimPrefix(context.Param("objectKey"), "/")
	ref, err := h.service.SignDownload(context.Request.Context(), objectKey)
	if err != nil {
		context.JSON(http.StatusNotFound, gin.H{"error": gin.H{"type": "artifact_missing", "message": err.Error()}})
		return
	}
	context.JSON(http.StatusOK, ref)
}

// renewKeyWithKey 换发当前这把密钥。路径里的 id 必须与调用方一致 ——
// 拿着 A 的密钥去换发 B 的密钥，等于替别人把凭证换掉。
func (h *Handler) renewKeyWithKey(context *gin.Context) {
	caller := corepkg.CallerFrom(context)
	keyID := context.Param("keyId")
	if keyID != caller.KeyID {
		context.JSON(http.StatusForbidden, gin.H{"error": gin.H{"type": "scope_denied", "message": "只能换发当前密钥"}})
		return
	}
	var req dto.RenewKeyRequest
	_ = context.ShouldBindJSON(&req)
	req.KeyID = keyID
	req.OwnerUserID = caller.OwnerUserID
	view, err := h.service.RenewKey(context.Request.Context(), req)
	if err != nil {
		context.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"type": "renew_failed", "message": err.Error()}})
		return
	}
	context.JSON(http.StatusOK, view)
}

func (h *Handler) usage(context *gin.Context) {
	caller := corepkg.CallerFrom(context)
	report, err := h.service.Usage(context.Request.Context(), dto.UsageQuery{
		ConsumerKey: caller.KeyID, Kind: context.Query("kind"),
		From: parseTime(context.Query("from")), To: parseTime(context.Query("to")),
	})
	if err != nil {
		context.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"type": "internal_error", "message": err.Error()}})
		return
	}
	context.JSON(http.StatusOK, report)
}

func (h *Handler) describeKey(context *gin.Context) {
	caller := corepkg.CallerFrom(context)
	view, err := h.service.DescribeKey(context.Request.Context(), caller.KeyID)
	if err != nil {
		context.JSON(http.StatusNotFound, gin.H{"error": gin.H{"type": "key_invalid", "message": err.Error()}})
		return
	}
	context.JSON(http.StatusOK, view)
}

// parseTime 接受 RFC3339；解析不了就返回零值，由 service 套默认区间。
func parseTime(value string) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}
