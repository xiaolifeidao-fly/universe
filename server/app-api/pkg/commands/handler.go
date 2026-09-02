package commands

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"common/middleware/httpx"
	"contract"
	"service/delivery"
	"service/delivery/dto"

	"github.com/gin-gonic/gin"
)

type CommandNotificationWaiter interface {
	WaitForCommand(ctx context.Context, userID string, timeout time.Duration) error
}

// CommandTerminalNotifier is deliberately best-effort: command persistence is
// complete before app-api asks a platform notification provider to deliver it.
type CommandTerminalNotifier interface {
	NotifyCommandTerminal(context.Context, dto.CommandView)
}

type Handler struct {
	service  delivery.CommandService
	waiter   CommandNotificationWaiter
	notifier CommandTerminalNotifier
}

const maxAttachmentUploadRequestBytes = 101 * 1024 * 1024
const maxAttachmentUploadBytes = 20 * 1024 * 1024
const commandEventPageSize = 200

func NewHandler(service delivery.CommandService, waiter CommandNotificationWaiter, notifier ...CommandTerminalNotifier) *Handler {
	handler := &Handler{service: service, waiter: waiter}
	if len(notifier) > 0 {
		handler.notifier = notifier[0]
	}
	return handler
}

func (h *Handler) Register(api *gin.RouterGroup) {
	commands := api.Group("/commands", httpx.RequireProductResearch())
	commands.POST("", h.submit)
	commands.POST("/attachments", h.uploadAttachments)
	commands.GET("", h.list)
	commands.GET("/:commandID", h.get)
	commands.POST("/:commandID/cancel", h.cancel)
	commands.GET("/:commandID/events", h.events)

	workers := api.Group("/workers", httpx.RequireProductResearch())
	// 只有这一条是给客户端读的：手机端在提交命令前先问「执行电脑在不在」。
	workers.GET("/status", h.workerStatus)
	workers.POST("/register", h.registerWorker)
	workers.POST("/heartbeat", h.heartbeat)
	workers.POST("/commands/claim", h.claim)
	workers.POST("/commands/:commandID/lease", h.renewLease)
	workers.POST("/commands/:commandID/activity", h.activity)
	workers.POST("/commands/:commandID/complete", h.complete)
	workers.GET("/attachments/:attachmentID", h.downloadAttachment)
}

func (h *Handler) submit(context *gin.Context) {
	bizLine, ok := requireBizLine(context)
	if !ok {
		return
	}
	var req dto.SubmitCommandRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !httpx.CanWriteProgram(context, bizLine.String(), req.ProgramID) {
		httpx.Fail(context, "无权在该项目提交命令")
		return
	}
	req.BizLine = bizLine
	req.UserID = httpx.CallerID(context)
	req.UserName = httpx.CallerName(context)
	view, err := h.service.SubmitCommand(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) uploadAttachments(context *gin.Context) {
	bizLine, ok := requireBizLine(context)
	if !ok {
		return
	}
	context.Request.Body = http.MaxBytesReader(context.Writer, context.Request.Body, maxAttachmentUploadRequestBytes)
	if err := context.Request.ParseMultipartForm(2 * 1024 * 1024); err != nil {
		httpx.Fail(context, "附件请求无效或超过 100 MB")
		return
	}
	defer func() {
		if context.Request.MultipartForm != nil {
			_ = context.Request.MultipartForm.RemoveAll()
		}
	}()
	programID, err := strconv.ParseInt(strings.TrimSpace(context.PostForm("programId")), 10, 64)
	if err != nil || programID <= 0 {
		httpx.Fail(context, "缺少项目标识")
		return
	}
	if !httpx.CanWriteProgram(context, bizLine.String(), programID) {
		httpx.Fail(context, "无权在该项目上传附件")
		return
	}
	itemKey := strings.TrimSpace(context.PostForm("itemKey"))
	files := context.Request.MultipartForm.File["files"]
	uploads := make([]dto.CommandAttachmentUpload, 0, len(files))
	for _, file := range files {
		opened, openErr := file.Open()
		if openErr != nil {
			httpx.Fail(context, "读取附件失败")
			return
		}
		data, readErr := io.ReadAll(io.LimitReader(opened, maxAttachmentUploadBytes+1))
		_ = opened.Close()
		if readErr != nil || len(data) > maxAttachmentUploadBytes {
			httpx.Fail(context, "单个附件不能超过 20 MB")
			return
		}
		uploads = append(uploads, dto.CommandAttachmentUpload{
			Name: file.Filename, ContentType: file.Header.Get("Content-Type"), Content: data,
		})
	}
	views, serviceErr := h.service.SaveCommandAttachments(context.Request.Context(), dto.SaveCommandAttachmentsRequest{
		BizLine: bizLine, ProgramID: programID, ItemKey: itemKey, UserID: httpx.CallerID(context), Uploads: uploads,
	})
	httpx.JSON(context, gin.H{"attachments": views}, serviceErr)
}

func (h *Handler) list(context *gin.Context) {
	bizLine, ok := requireBizLine(context)
	if !ok {
		return
	}
	var query dto.CommandQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if query.ProgramID > 0 && httpx.AuthorizeProgramInBizLine(context, bizLine.String(), query.ProgramID) != nil {
		httpx.Fail(context, "无权访问该项目")
		return
	}
	query.BizLine = bizLine
	query.UserID = httpx.CallerID(context)
	page, err := h.service.ListCommands(context.Request.Context(), query)
	httpx.JSON(context, page, err)
}

func (h *Handler) get(context *gin.Context) {
	_, view, ok := h.commandForCurrentUser(context)
	if !ok {
		return
	}
	httpx.JSON(context, view, nil)
}

func (h *Handler) cancel(context *gin.Context) {
	bizLine, current, ok := h.commandForCurrentUser(context)
	if !ok {
		return
	}
	if !httpx.CanWriteProgram(context, bizLine.String(), current.ProgramID) {
		httpx.Fail(context, "无权取消该项目命令")
		return
	}
	var req dto.CancelCommandRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.BizLine = bizLine
	req.UserID = httpx.CallerID(context)
	req.CommandID = context.Param("commandID")
	view, err := h.service.RequestCommandCancellation(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) workerStatus(context *gin.Context) {
	bizLine, ok := requireBizLine(context)
	if !ok {
		return
	}
	programID, err := strconv.ParseInt(strings.TrimSpace(context.DefaultQuery("programId", "0")), 10, 64)
	if err != nil {
		httpx.Fail(context, "项目标识格式不正确")
		return
	}
	if programID > 0 && httpx.AuthorizeProgramInBizLine(context, bizLine.String(), programID) != nil {
		httpx.Fail(context, "无权访问该项目")
		return
	}
	view, err := h.service.GetCommandWorkerStatus(context.Request.Context(), bizLine, httpx.CallerID(context), programID)
	httpx.JSON(context, view, err)
}

func (h *Handler) registerWorker(context *gin.Context) {
	bizLine, ok := requireBizLine(context)
	if !ok {
		return
	}
	var req dto.RegisterCommandWorkerRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	for _, programID := range req.ProgramIDs {
		if !httpx.CanWriteProgram(context, bizLine.String(), programID) {
			httpx.Fail(context, "无权登记该项目工作目录映射")
			return
		}
	}
	req.BizLine = bizLine
	req.UserID = httpx.CallerID(context)
	view, err := h.service.RegisterCommandWorker(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) heartbeat(context *gin.Context) {
	bizLine, ok := requireBizLine(context)
	if !ok {
		return
	}
	var req dto.WorkerHeartbeatRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.BizLine = bizLine
	req.UserID = httpx.CallerID(context)
	err := h.service.HeartbeatCommandWorker(context.Request.Context(), req)
	httpx.JSON(context, gin.H{"ok": err == nil}, err)
}

func (h *Handler) claim(context *gin.Context) {
	var req dto.ClaimCommandRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.UserID = httpx.CallerID(context)
	if h.waiter != nil {
		_ = h.waiter.WaitForCommand(context.Request.Context(), req.UserID, commandWaitDuration(context.Query("waitSeconds")))
	}
	claimed, err := h.service.ClaimCommand(context.Request.Context(), req)
	httpx.JSON(context, claimed, err)
}

func (h *Handler) renewLease(context *gin.Context) {
	bizLine, _, ok := h.commandForCurrentUser(context)
	if !ok {
		return
	}
	var req dto.RenewCommandLeaseRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.BizLine = bizLine
	req.UserID = httpx.CallerID(context)
	req.CommandID = context.Param("commandID")
	view, err := h.service.RenewCommandLease(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) activity(context *gin.Context) {
	bizLine, _, ok := h.commandForCurrentUser(context)
	if !ok {
		return
	}
	var req dto.ReportCommandActivityRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.BizLine = bizLine
	req.UserID = httpx.CallerID(context)
	req.CommandID = context.Param("commandID")
	view, err := h.service.ReportCommandActivity(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) complete(context *gin.Context) {
	bizLine, _, ok := h.commandForCurrentUser(context)
	if !ok {
		return
	}
	var req dto.CompleteCommandRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.BizLine = bizLine
	req.UserID = httpx.CallerID(context)
	req.CommandID = context.Param("commandID")
	view, err := h.service.CompleteCommand(context.Request.Context(), req)
	if err == nil && h.notifier != nil {
		h.notifier.NotifyCommandTerminal(context.Request.Context(), view)
	}
	httpx.JSON(context, view, err)
}

func (h *Handler) downloadAttachment(context *gin.Context) {
	bizLine, ok := requireBizLine(context)
	if !ok {
		return
	}
	programID, err := strconv.ParseInt(strings.TrimSpace(context.Query("programId")), 10, 64)
	if err != nil || programID <= 0 {
		httpx.Fail(context, "缺少项目标识")
		return
	}
	if err := httpx.AuthorizeProgramInBizLine(context, bizLine.String(), programID); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	attachment, serviceErr := h.service.GetCommandAttachment(
		context.Request.Context(), bizLine, httpx.CallerID(context), programID, context.Param("attachmentID"),
	)
	if serviceErr != nil {
		httpx.JSON(context, nil, serviceErr)
		return
	}
	contentType := attachment.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	context.Header("Content-Type", contentType)
	context.Header("X-Delivery-Attachment-ID", attachment.AttachmentID)
	context.Header("X-Delivery-Attachment-Name", attachment.Name)
	context.Header("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": attachment.Name}))
	context.Data(http.StatusOK, contentType, attachment.Content)
}

func (h *Handler) events(context *gin.Context) {
	bizLine, command, ok := h.commandForCurrentUser(context)
	if !ok {
		return
	}
	afterID, _ := strconv.ParseInt(strings.TrimSpace(context.Query("afterId")), 10, 64)
	if lastID, err := strconv.ParseInt(strings.TrimSpace(context.GetHeader("Last-Event-ID")), 10, 64); err == nil && lastID > afterID {
		afterID = lastID
	}
	writer := context.Writer
	writer.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-cache, no-transform")
	writer.Header().Set("Connection", "keep-alive")
	writer.Header().Set("X-Accel-Buffering", "no")
	flusher, ok := writer.(http.Flusher)
	if !ok {
		httpx.Fail(context, "当前响应不支持 SSE")
		return
	}
	fmt.Fprint(writer, "retry: 3000\n: connected\n\n")
	flusher.Flush()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()
	for {
		events, err := h.service.ListCommandEvents(context.Request.Context(), dto.CommandEventQuery{BizLine: bizLine, UserID: httpx.CallerID(context), CommandID: command.CommandID, AfterID: afterID, Limit: commandEventPageSize})
		if err != nil {
			return
		}
		for _, event := range events {
			payload, err := json.Marshal(event)
			if err != nil {
				continue
			}
			fmt.Fprintf(writer, "id: %d\nevent: command\ndata: %s\n\n", event.ID, payload)
			afterID = event.ID
		}
		if len(events) > 0 {
			flusher.Flush()
		}
		// Terminal commands may have more than one page of durable activity.
		// Drain those pages before closing so a PWA reconnect can recover its
		// complete timeline instead of stopping at the first 200 events.
		if isTerminal(command.State) && len(events) < commandEventPageSize {
			return
		}
		if isTerminal(command.State) {
			continue
		}
		select {
		case <-context.Request.Context().Done():
			return
		case <-ticker.C:
			latest, err := h.service.GetCommand(context.Request.Context(), bizLine, httpx.CallerID(context), command.CommandID)
			if err == nil {
				command = latest
			}
		case <-keepalive.C:
			fmt.Fprint(writer, ": keep-alive\n\n")
			flusher.Flush()
		}
	}
}

func (h *Handler) commandForCurrentUser(context *gin.Context) (contract.BizLine, dto.CommandView, bool) {
	bizLine, ok := requireBizLine(context)
	if !ok {
		return "", dto.CommandView{}, false
	}
	view, err := h.service.GetCommand(context.Request.Context(), bizLine, httpx.CallerID(context), context.Param("commandID"))
	if err != nil {
		httpx.JSON(context, nil, err)
		return "", dto.CommandView{}, false
	}
	if err := httpx.AuthorizeProgramInBizLine(context, bizLine.String(), view.ProgramID); err != nil {
		httpx.JSON(context, nil, err)
		return "", dto.CommandView{}, false
	}
	return bizLine, view, true
}

func requireBizLine(context *gin.Context) (contract.BizLine, bool) {
	bizLine := contract.BizLine(httpx.BizLine(context))
	if !bizLine.Valid() {
		httpx.JSON(context, nil, contract.ErrBizLineRequired)
		return "", false
	}
	if err := httpx.AuthorizeBizLine(context, bizLine.String()); err != nil {
		httpx.JSON(context, nil, err)
		return "", false
	}
	return bizLine, true
}

func commandWaitDuration(value string) time.Duration {
	seconds, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || seconds <= 0 {
		seconds = 20
	}
	if seconds > 25 {
		seconds = 25
	}
	return time.Duration(seconds) * time.Second
}

func isTerminal(state string) bool {
	return state == "succeeded" || state == "failed" || state == "cancelled" || state == "timed_out"
}
