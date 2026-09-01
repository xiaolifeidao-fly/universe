package commands

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"common/middleware/httpx"
	"contract"
	"service/delivery"
	"service/delivery/dto"

	"github.com/gin-gonic/gin"
)

type testAuthenticator struct{ principal httpx.UserPrincipal }

func (a testAuthenticator) AuthenticateToken(context.Context, string) (httpx.UserPrincipal, error) {
	return a.principal, nil
}

type recordingCommandService struct {
	delivery.CommandService
	submitted  dto.SubmitCommandRequest
	attachment dto.SaveCommandAttachmentsRequest
}

type terminalEventCommandService struct {
	delivery.CommandService
	events   []dto.CommandEventView
	afterIDs []int64
}

func (s *terminalEventCommandService) GetCommand(_ context.Context, _ contract.BizLine, _ string, _ string) (dto.CommandView, error) {
	return dto.CommandView{CommandID: "cmd-terminal", ProgramID: 16, State: "succeeded"}, nil
}

func (s *terminalEventCommandService) ListCommandEvents(_ context.Context, query dto.CommandEventQuery) ([]dto.CommandEventView, error) {
	s.afterIDs = append(s.afterIDs, query.AfterID)
	result := make([]dto.CommandEventView, 0, query.Limit)
	for _, event := range s.events {
		if event.ID <= query.AfterID {
			continue
		}
		result = append(result, event)
		if len(result) == query.Limit {
			break
		}
	}
	return result, nil
}

func (s *recordingCommandService) SubmitCommand(_ context.Context, req dto.SubmitCommandRequest) (dto.CommandView, error) {
	s.submitted = req
	return dto.CommandView{CommandID: "cmd-test", BizLine: req.BizLine.String(), ProgramID: req.ProgramID, UserID: req.UserID}, nil
}

func (s *recordingCommandService) SaveCommandAttachments(_ context.Context, req dto.SaveCommandAttachmentsRequest) ([]dto.CommandAttachmentView, error) {
	s.attachment = req
	return []dto.CommandAttachmentView{{AttachmentID: "attachment-0123456789abcdef0123456789abcdef", ProgramID: req.ProgramID, ItemKey: req.ItemKey, Name: req.Uploads[0].Name, Size: int64(len(req.Uploads[0].Content))}}, nil
}

func TestSubmitUsesAuthenticatedUserInsteadOfRequestPayload(t *testing.T) {
	gin.SetMode(gin.TestMode)
	httpx.SetUserAuthenticator(testAuthenticator{principal: httpx.UserPrincipal{
		ID: "42", DisplayName: "Nina", Persona: "product_research", BizLines: []string{"whatsapp"}, WritableBizLines: []string{"whatsapp"},
	}})
	defer httpx.SetUserAuthenticator(nil)
	service := &recordingCommandService{}
	router := gin.New()
	NewHandler(service, nil).Register(router.Group("/api"))
	request := httptest.NewRequest(http.MethodPost, "/api/commands", bytes.NewBufferString(`{"programId":16,"commandType":"task.execute","input":{"itemKey":"a"},"idempotencyKey":"request-1","userId":"other-user"}`))
	request.Header.Set("token", "valid")
	request.Header.Set("X-Biz-Line", "whatsapp")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !bytes.Contains(recorder.Body.Bytes(), []byte(`"success":true`)) {
		t.Fatalf("提交失败：%s", recorder.Body.String())
	}
	if service.submitted.UserID != "42" || service.submitted.UserName != "Nina" {
		t.Fatalf("命令用户必须由认证上下文覆盖，实际 %#v", service.submitted)
	}
	if service.submitted.BizLine != contract.BizLine("whatsapp") {
		t.Fatalf("命令业务线未从认证请求提取：%q", service.submitted.BizLine)
	}
}

func TestAttachmentUploadUsesAuthenticatedProjectContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	httpx.SetUserAuthenticator(testAuthenticator{principal: httpx.UserPrincipal{
		ID: "42", Persona: "product_research", Personas: []string{"product_research"}, BizLines: []string{"whatsapp"}, WritableBizLines: []string{"whatsapp"},
	}})
	defer httpx.SetUserAuthenticator(nil)
	service := &recordingCommandService{}
	router := gin.New()
	NewHandler(service, nil).Register(router.Group("/api"))
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("programId", "16")
	_ = writer.WriteField("itemKey", "mobile-execution")
	part, err := writer.CreateFormFile("files", "brief.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("attachment body"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/commands/attachments", &body)
	request.Header.Set("token", "valid")
	request.Header.Set("X-Biz-Line", "whatsapp")
	request.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !bytes.Contains(recorder.Body.Bytes(), []byte(`"attachmentId"`)) {
		t.Fatalf("附件上传失败：%s", recorder.Body.String())
	}
	if service.attachment.UserID != "42" || service.attachment.BizLine != contract.BizLine("whatsapp") || service.attachment.ProgramID != 16 {
		t.Fatalf("附件上下文没有由认证请求覆盖：%#v", service.attachment)
	}
	if len(service.attachment.Uploads) != 1 || string(service.attachment.Uploads[0].Content) != "attachment body" {
		t.Fatalf("附件内容未正确传给领域服务：%#v", service.attachment.Uploads)
	}
}

func TestEventsDrainTerminalHistoryAcrossPages(t *testing.T) {
	gin.SetMode(gin.TestMode)
	httpx.SetUserAuthenticator(testAuthenticator{principal: httpx.UserPrincipal{
		ID: "42", Persona: "product_research", Personas: []string{"product_research"}, BizLines: []string{"whatsapp"}, WritableBizLines: []string{"whatsapp"},
	}})
	defer httpx.SetUserAuthenticator(nil)
	events := make([]dto.CommandEventView, 0, commandEventPageSize+1)
	for id := 1; id <= commandEventPageSize+1; id++ {
		events = append(events, dto.CommandEventView{ID: int64(id), Kind: "activity", State: "running", Message: "进度 " + strconv.Itoa(id), Data: []byte(`{}`), CreatedAt: time.Unix(int64(id), 0)})
	}
	service := &terminalEventCommandService{events: events}
	router := gin.New()
	NewHandler(service, nil).Register(router.Group("/api"))
	request := httptest.NewRequest(http.MethodGet, "/api/commands/cmd-terminal/events", nil)
	request.Header.Set("token", "valid")
	request.Header.Set("X-Biz-Line", "whatsapp")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !bytes.Contains(recorder.Body.Bytes(), []byte("id: 201")) {
		t.Fatalf("终态命令的第二页事件没有回放：status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if len(service.afterIDs) < 2 || service.afterIDs[0] != 0 || service.afterIDs[1] != commandEventPageSize {
		t.Fatalf("SSE 游标分页不正确：%v", service.afterIDs)
	}
}
