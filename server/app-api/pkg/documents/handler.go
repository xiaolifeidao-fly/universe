// Package documents exposes cloud-synchronised project files to authenticated
// mobile clients. It never accepts a local path or returns an OSS credential.
package documents

import (
	"context"
	"errors"
	"mime"
	"path"
	"strconv"
	"strings"
	"time"

	"common/middleware/httpx"
	"common/objectstore"
	"contract"
	"service/delivery/dto"

	"github.com/gin-gonic/gin"
)

const (
	maxPreviewBytes     = 8 * 1024 * 1024
	defaultSignedURLTTL = 5 * time.Minute
)

// Directory is the smallest delivery-domain view needed by the HTTP adapter.
// Keeping it narrow makes the app API a caller of delivery rather than another
// owner of project or document state.
type Directory interface {
	ResolveProgramBizLine(context.Context, int64) (contract.BizLine, error)
	ListCloudSyncFiles(context.Context, dto.CloudSyncFileQuery) ([]dto.CloudSyncFileView, error)
	GetCloudSyncFile(context.Context, contract.BizLine, int64, string, string) (dto.CloudSyncFileView, error)
}

type ObjectReader interface {
	Get(context.Context, string) (objectstore.ObjectContent, error)
	SignedURL(string, time.Time) (string, error)
}

type Handler struct {
	directory    Directory
	objects      ObjectReader
	now          func() time.Time
	signedURLTTL time.Duration
}

func NewHandler(directory Directory, objects ObjectReader, signedURLTTL time.Duration) *Handler {
	if signedURLTTL <= 0 {
		signedURLTTL = defaultSignedURLTTL
	}
	return &Handler{directory: directory, objects: objects, now: time.Now, signedURLTTL: signedURLTTL}
}

func (h *Handler) Register(api *gin.RouterGroup) {
	documents := api.Group("/documents", httpx.RequireProductResearch())
	documents.GET("", h.list)
	documents.GET("/preview", h.preview)
	documents.GET("/url", h.signedURL)
}

func (h *Handler) list(c *gin.Context) {
	programID, bizLine, ok := h.authorizeProgram(c)
	if !ok {
		return
	}
	files, err := h.directory.ListCloudSyncFiles(c.Request.Context(), dto.CloudSyncFileQuery{
		BizLine: bizLine, ProgramID: programID, Category: strings.TrimSpace(c.Query("category")),
		// 手机上点开一条需求或一条任务的文档时，只取它自己的那一份目录，不用把整个项目拉回来再筛。
		OwnerKind: strings.TrimSpace(c.Query("ownerKind")),
		OwnerKey:  strings.TrimSpace(c.Query("ownerKey")),
		Stage:     strings.TrimSpace(c.Query("stage")),
	})
	httpx.JSON(c, files, err)
}

func (h *Handler) preview(c *gin.Context) {
	file, ok := h.authorizeFile(c)
	if !ok {
		return
	}
	if h.objects == nil {
		httpx.Fail(c, "服务器未配置 OSS 云存储")
		return
	}
	object, err := h.objects.Get(c.Request.Context(), file.ObjectKey)
	if err != nil {
		httpx.JSON(c, nil, err)
		return
	}
	if len(object.Data) > maxPreviewBytes {
		httpx.Fail(c, "云端文件不能超过 8MB")
		return
	}
	contentType := strings.TrimSpace(file.ContentType)
	if contentType == "" {
		contentType = strings.TrimSpace(object.ContentType)
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	filename := path.Base(file.RelativePath)
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": filename}))
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(200, contentType, object.Data)
}

func (h *Handler) signedURL(c *gin.Context) {
	file, ok := h.authorizeFile(c)
	if !ok {
		return
	}
	if h.objects == nil {
		httpx.Fail(c, "服务器未配置 OSS 云存储")
		return
	}
	expiresAt := h.now().Add(h.signedURLTTL).UTC()
	url, err := h.objects.SignedURL(file.ObjectKey, expiresAt)
	if err != nil {
		httpx.JSON(c, nil, err)
		return
	}
	httpx.JSON(c, gin.H{"url": url, "expiresAt": expiresAt}, nil)
}

func (h *Handler) authorizeFile(c *gin.Context) (dto.CloudSyncFileView, bool) {
	programID, bizLine, ok := h.authorizeProgram(c)
	if !ok {
		return dto.CloudSyncFileView{}, false
	}
	file, err := h.directory.GetCloudSyncFile(c.Request.Context(), bizLine, programID, strings.TrimSpace(c.Query("category")), c.Query("relativePath"))
	if err != nil {
		httpx.JSON(c, nil, err)
		return dto.CloudSyncFileView{}, false
	}
	if strings.TrimSpace(file.ObjectKey) == "" {
		httpx.Fail(c, "云端文件对象无效")
		return dto.CloudSyncFileView{}, false
	}
	return file, true
}

func (h *Handler) authorizeProgram(c *gin.Context) (int64, contract.BizLine, bool) {
	programID, err := strconv.ParseInt(c.Query("programId"), 10, 64)
	if err != nil || programID <= 0 {
		httpx.JSON(c, nil, errors.New("缺少项目标识"))
		return 0, "", false
	}
	bizLine, err := h.directory.ResolveProgramBizLine(c.Request.Context(), programID)
	if err != nil {
		httpx.JSON(c, nil, err)
		return 0, "", false
	}
	if err := httpx.AuthorizeProgramInBizLine(c, bizLine.String(), programID); err != nil {
		httpx.JSON(c, nil, err)
		return 0, "", false
	}
	return programID, bizLine, true
}
