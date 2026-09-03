package management

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"common/middleware/httpx"
	"contract"
	bizlinedto "service/bizline/dto"
	"service/business"
	businessdto "service/business/dto"
	"service/delivery"
	deliverydto "service/delivery/dto"
	"service/identity"
	identitydto "service/identity/dto"

	"github.com/gin-gonic/gin"
)

type testAuthenticator struct{ principal httpx.UserPrincipal }

func (a testAuthenticator) AuthenticateToken(context.Context, string) (httpx.UserPrincipal, error) {
	return a.principal, nil
}

type recordingDeliveryService struct {
	delivery.Service
	patched deliverydto.PatchItemRequest
	renamed deliverydto.UpdateRequirementNameRequest
	bound   deliverydto.BindRequirementGitBranchRequest

	batchNotificationQuery      deliverydto.ExecutionBatchNotificationQuery
	batchNotificationRead       deliverydto.MarkExecutionBatchNotificationReadRequest
	completionNotificationQuery deliverydto.RequirementCompletionNotificationQuery
	completionNotificationRead  deliverydto.MarkRequirementCompletionNotificationReadRequest
}

func (s *recordingDeliveryService) ListExecutionBatchNotifications(_ context.Context, query deliverydto.ExecutionBatchNotificationQuery) ([]deliverydto.ExecutionBatchView, error) {
	s.batchNotificationQuery = query
	return []deliverydto.ExecutionBatchView{{BatchID: "batch-1", ProgramID: query.ProgramID}}, nil
}

func (s *recordingDeliveryService) MarkExecutionBatchNotificationRead(_ context.Context, req deliverydto.MarkExecutionBatchNotificationReadRequest) (deliverydto.ExecutionBatchView, error) {
	s.batchNotificationRead = req
	return deliverydto.ExecutionBatchView{BatchID: req.BatchID, ProgramID: req.ProgramID}, nil
}

func (s *recordingDeliveryService) ListRequirementCompletionNotifications(_ context.Context, query deliverydto.RequirementCompletionNotificationQuery) ([]deliverydto.RequirementCompletionNotificationView, error) {
	s.completionNotificationQuery = query
	return []deliverydto.RequirementCompletionNotificationView{{RequirementKey: "req-1", ProgramID: query.ProgramID}}, nil
}

func (s *recordingDeliveryService) MarkRequirementCompletionNotificationRead(_ context.Context, req deliverydto.MarkRequirementCompletionNotificationReadRequest) (deliverydto.RequirementCompletionNotificationView, error) {
	s.completionNotificationRead = req
	return deliverydto.RequirementCompletionNotificationView{RequirementKey: req.RequirementKey, ProgramID: req.ProgramID}, nil
}

func (s *recordingDeliveryService) ResolveProgramBizLine(context.Context, int64) (contract.BizLine, error) {
	return contract.BizLine("whatsapp"), nil
}

func (s *recordingDeliveryService) PatchItem(_ context.Context, req deliverydto.PatchItemRequest) (deliverydto.ItemView, error) {
	s.patched = req
	return deliverydto.ItemView{ItemKey: req.ItemKey, ProgramID: req.ProgramID}, nil
}

func (s *recordingDeliveryService) UpdateRequirementName(_ context.Context, req deliverydto.UpdateRequirementNameRequest) (deliverydto.RequirementView, error) {
	s.renamed = req
	return deliverydto.RequirementView{RequirementKey: req.RequirementKey, ProgramID: req.ProgramID, Name: req.Name}, nil
}

func (s *recordingDeliveryService) BindRequirementGitBranch(_ context.Context, req deliverydto.BindRequirementGitBranchRequest) (deliverydto.RequirementView, error) {
	s.bound = req
	return deliverydto.RequirementView{RequirementKey: req.RequirementKey, ProgramID: req.ProgramID, GitBranch: req.GitBranch}, nil
}

type recordingIdentityService struct{ identity.Service }

func (s *recordingIdentityService) ListProgramMembers(context.Context, int64) ([]identitydto.MemberView, error) {
	return []identitydto.MemberView{{ID: "member-1", DisplayName: "Mira"}}, nil
}

type noBusinessService struct{ business.Service }

type recordingBusinessService struct {
	business.Service
	conversationQuery businessdto.ConversationQuery
	collectedQuery    businessdto.CollectedRequirementQuery
	sent              businessdto.SendMessageRequest
	referenceQuery    businessdto.DocumentReferenceQuery
}

func (s *recordingBusinessService) GetConversation(_ context.Context, query businessdto.ConversationQuery) (businessdto.ConversationView, error) {
	s.conversationQuery = query
	return businessdto.ConversationView{Requirement: businessdto.RequirementView{ID: query.RequirementID}}, nil
}

func (s *recordingBusinessService) ListCollectedRequirements(_ context.Context, query businessdto.CollectedRequirementQuery) (businessdto.RequirementPage, error) {
	s.collectedQuery = query
	return businessdto.RequirementPage{Total: 1, Data: []businessdto.RequirementView{{ID: 91}}}, nil
}

func (s *recordingBusinessService) ListDocumentReferences(_ context.Context, query businessdto.DocumentReferenceQuery) ([]businessdto.DocumentReferenceView, error) {
	s.referenceQuery = query
	return []businessdto.DocumentReferenceView{{DocumentID: 5, Title: "渠道看板"}}, nil
}

func (s *recordingBusinessService) SendMessage(_ context.Context, req businessdto.SendMessageRequest) (businessdto.SendMessageResult, error) {
	s.sent = req
	return businessdto.SendMessageResult{ThreadID: "thread-1", Active: true}, nil
}

func TestPatchUsesAuthenticatedActorAndCanonicalMemberName(t *testing.T) {
	gin.SetMode(gin.TestMode)
	httpx.SetUserAuthenticator(testAuthenticator{principal: httpx.UserPrincipal{
		ID: "42", Persona: "product_research", Personas: []string{"product_research"}, BizLines: []string{"whatsapp"}, WritableBizLines: []string{"whatsapp"},
	}})
	defer httpx.SetUserAuthenticator(nil)
	deliveryService := &recordingDeliveryService{}
	router := gin.New()
	NewHandler(deliveryService, &recordingIdentityService{}, &noBusinessService{}, nil).Register(router.Group("/api"))
	request := httptest.NewRequest(http.MethodPost, "/api/delivery/item/patch", bytes.NewBufferString(`{"programId":16,"itemKey":"mobile-api","version":2,"ownerId":"member-1","ownerName":"forged","dependsOnItemKeys":["command-center"]}`))
	request.Header.Set("token", "valid")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || deliveryService.patched.ActorID != "42" || deliveryService.patched.BizLine != contract.BizLine("whatsapp") {
		t.Fatalf("任务编辑未使用认证上下文：status=%d request=%#v", recorder.Code, deliveryService.patched)
	}
	if deliveryService.patched.OwnerName == nil || *deliveryService.patched.OwnerName != "Mira" {
		t.Fatalf("负责人显示名必须由项目成员目录覆盖：%#v", deliveryService.patched.OwnerName)
	}
}

func TestBusinessConversationUsesAuthenticatedCreator(t *testing.T) {
	gin.SetMode(gin.TestMode)
	httpx.SetUserAuthenticator(testAuthenticator{principal: httpx.UserPrincipal{
		ID: "42", Username: "alice", Persona: "product_research", Personas: []string{"product_research", "business"},
		BizLines: []string{"whatsapp"}, WritableBizLines: []string{"whatsapp"},
	}})
	defer httpx.SetUserAuthenticator(nil)
	businessService := &recordingBusinessService{}
	router := gin.New()
	NewHandler(&recordingDeliveryService{}, &recordingIdentityService{}, businessService, nil).Register(router.Group("/api"))

	request := httptest.NewRequest(http.MethodGet, "/api/business/requirement?bizLine=whatsapp&requirementId=77", nil)
	request.Header.Set("token", "valid")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK || businessService.conversationQuery.RequirementID != 77 || businessService.conversationQuery.CreatorID != "42" || businessService.conversationQuery.BizLine != contract.BizLine("whatsapp") {
		t.Fatalf("业务会话未使用登录身份：status=%d query=%#v body=%s", recorder.Code, businessService.conversationQuery, recorder.Body.String())
	}
}

func TestBusinessMessageAndResearchRoutesKeepPersonaBoundaries(t *testing.T) {
	gin.SetMode(gin.TestMode)
	httpx.SetUserAuthenticator(testAuthenticator{principal: httpx.UserPrincipal{
		ID: "42", Username: "alice", Persona: "product_research", Personas: []string{"product_research", "business"},
		BizLines: []string{"whatsapp"}, WritableBizLines: []string{"whatsapp"},
	}})
	defer httpx.SetUserAuthenticator(nil)
	businessService := &recordingBusinessService{}
	router := gin.New()
	NewHandler(&recordingDeliveryService{}, &recordingIdentityService{}, businessService, nil).Register(router.Group("/api"))

	messageRequest := httptest.NewRequest(http.MethodPost, "/api/business/requirement/messages?bizLine=whatsapp", bytes.NewBufferString(`{"requirementId":77,"content":"需要渠道看板","mode":"statement"}`))
	messageRequest.Header.Set("token", "valid")
	messageRequest.Header.Set("Content-Type", "application/json")
	messageRecorder := httptest.NewRecorder()
	router.ServeHTTP(messageRecorder, messageRequest)
	if messageRecorder.Code != http.StatusOK || businessService.sent.CreatorID != "42" || businessService.sent.CreatorUsername != "alice" || businessService.sent.BizLine != contract.BizLine("whatsapp") {
		t.Fatalf("业务消息未绑定登录身份：status=%d request=%#v body=%s", messageRecorder.Code, businessService.sent, messageRecorder.Body.String())
	}

	referenceRequest := httptest.NewRequest(http.MethodGet, "/api/business/requirement/references?bizLine=whatsapp&requirementId=77&keyword=%E7%9C%8B%E6%9D%BF", nil)
	referenceRequest.Header.Set("token", "valid")
	referenceRecorder := httptest.NewRecorder()
	router.ServeHTTP(referenceRecorder, referenceRequest)
	if referenceRecorder.Code != http.StatusOK || businessService.referenceQuery.RequirementID != 77 || businessService.referenceQuery.CreatorID != "42" ||
		businessService.referenceQuery.BizLine != contract.BizLine("whatsapp") || businessService.referenceQuery.Keyword != "看板" {
		t.Fatalf("@ 文档候选未按登录身份与关键字查询：status=%d query=%#v body=%s", referenceRecorder.Code, businessService.referenceQuery, referenceRecorder.Body.String())
	}

	researchRequest := httptest.NewRequest(http.MethodGet, "/api/business/research/requirements?bizLine=whatsapp&pageIndex=2&pageSize=30", nil)
	researchRequest.Header.Set("token", "valid")
	researchRecorder := httptest.NewRecorder()
	router.ServeHTTP(researchRecorder, researchRequest)
	if researchRecorder.Code != http.StatusOK || businessService.collectedQuery.BizLine != contract.BizLine("whatsapp") || businessService.collectedQuery.Page.PageIndex != 2 || businessService.collectedQuery.Page.PageSize != 30 {
		t.Fatalf("诉求采集查询未正确透传：status=%d query=%#v body=%s", researchRecorder.Code, businessService.collectedQuery, researchRecorder.Body.String())
	}
}

func TestBusinessAndResearchRoutesRejectWrongPersona(t *testing.T) {
	gin.SetMode(gin.TestMode)
	defer httpx.SetUserAuthenticator(nil)

	request := func(principal httpx.UserPrincipal, method, target string) *httptest.ResponseRecorder {
		httpx.SetUserAuthenticator(testAuthenticator{principal: principal})
		router := gin.New()
		NewHandler(&recordingDeliveryService{}, &recordingIdentityService{}, &recordingBusinessService{}, nil).Register(router.Group("/api"))
		req := httptest.NewRequest(method, target, nil)
		req.Header.Set("token", "valid")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, req)
		return recorder
	}

	productOnly := httpx.UserPrincipal{
		ID: "42", Username: "alice", Persona: "product_research", Personas: []string{"product_research"},
		BizLines: []string{"whatsapp"}, WritableBizLines: []string{"whatsapp"},
	}
	businessRecorder := request(productOnly, http.MethodGet, "/api/business/requirements?bizLine=whatsapp")
	if !strings.Contains(businessRecorder.Body.String(), "当前登录身份不是业务方") {
		t.Fatalf("产品产研单一身份不应访问业务工作台：body=%s", businessRecorder.Body.String())
	}

	businessOnly := httpx.UserPrincipal{
		ID: "42", Username: "alice", Persona: "business", Personas: []string{"business"},
		BizLines: []string{"whatsapp"}, WritableBizLines: []string{"whatsapp"},
	}
	researchRecorder := request(businessOnly, http.MethodGet, "/api/business/research/requirements?bizLine=whatsapp")
	if !strings.Contains(researchRecorder.Body.String(), "当前登录身份不是产品产研") {
		t.Fatalf("业务单一身份不应访问诉求采集：body=%s", researchRecorder.Body.String())
	}
}

type stubSpaceDirectory struct{ views []bizlinedto.BizLineView }

func (d stubSpaceDirectory) List(context.Context) ([]bizlinedto.BizLineView, error) {
	return d.views, nil
}

// 空间切换器只能列出调用者进得去的空间，否则用户会选到一个立刻报
// 「无权访问该空间」的选项 —— 这正是让移动端不再手输业务线编码的原因。
func TestListSpacesKeepsOnlyAccessibleSpaces(t *testing.T) {
	gin.SetMode(gin.TestMode)
	httpx.SetUserAuthenticator(testAuthenticator{principal: httpx.UserPrincipal{
		ID: "42", Persona: "product_research", Personas: []string{"product_research"},
		BizLines: []string{"whatsapp"}, WritableBizLines: []string{"whatsapp"}, ManagedBizLines: []string{"tiktok"},
	}})
	defer httpx.SetUserAuthenticator(nil)
	directory := stubSpaceDirectory{views: []bizlinedto.BizLineView{
		{Code: "whatsapp", Name: "WhatsApp", Enabled: true, Visible: true},
		{Code: "tiktok", Name: "", Enabled: true, Visible: false},
		{Code: "line", Name: "LINE", Enabled: true, Visible: true},
	}}
	router := gin.New()
	NewHandler(&recordingDeliveryService{}, &recordingIdentityService{}, &noBusinessService{}, directory).Register(router.Group("/api"))
	request := httptest.NewRequest(http.MethodGet, "/api/spaces", nil)
	request.Header.Set("token", "valid")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	var payload struct {
		Data []SpaceView `json:"data"`
	}
	if recorder.Code != http.StatusOK || json.Unmarshal(recorder.Body.Bytes(), &payload) != nil {
		t.Fatalf("空间列表请求失败：status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if len(payload.Data) != 2 {
		t.Fatalf("只应返回可访问的两个空间：%#v", payload.Data)
	}
	if payload.Data[0].Code != "whatsapp" || payload.Data[0].Name != "WhatsApp" || !payload.Data[0].CanWrite {
		t.Fatalf("成员空间的显示名和写入权不正确：%#v", payload.Data[0])
	}
	// 空间管理员看得到自己管理的不可见空间；没有显示名时回落到编码。
	if payload.Data[1].Code != "tiktok" || payload.Data[1].Name != "tiktok" || !payload.Data[1].CanManage {
		t.Fatalf("管理的空间未正确返回：%#v", payload.Data[1])
	}
}

// 没有空间注册表时（例如注册表尚未装配），列表退化成 token 里的授权编码，
// 而不是让移动端拿到一个空列表、卡在「没有可用空间」。
func TestListSpacesFallsBackToPrincipalScopes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	httpx.SetUserAuthenticator(testAuthenticator{principal: httpx.UserPrincipal{
		ID: "42", Persona: "product_research", Personas: []string{"product_research"},
		BizLines: []string{"whatsapp"}, ManagedBizLines: []string{"whatsapp", "tiktok"},
	}})
	defer httpx.SetUserAuthenticator(nil)
	router := gin.New()
	NewHandler(&recordingDeliveryService{}, &recordingIdentityService{}, &noBusinessService{}, nil).Register(router.Group("/api"))
	request := httptest.NewRequest(http.MethodGet, "/api/spaces", nil)
	request.Header.Set("token", "valid")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	var payload struct {
		Data []SpaceView `json:"data"`
	}
	if recorder.Code != http.StatusOK || json.Unmarshal(recorder.Body.Bytes(), &payload) != nil {
		t.Fatalf("空间列表请求失败：status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if len(payload.Data) != 2 || payload.Data[0].Code != "tiktok" || payload.Data[1].Code != "whatsapp" {
		t.Fatalf("退化列表应按编码去重排序：%#v", payload.Data)
	}
}

// 手机端新建需求会依次调这两条：分支建成后回记关联，名称先写需求编号占位。
// 两条都只认 token 里的身份和项目所属业务线，请求体里带什么都不作数。
func TestRequirementNameAndGitBranchRoutesUseAuthenticatedContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	httpx.SetUserAuthenticator(testAuthenticator{principal: httpx.UserPrincipal{
		ID: "42", Persona: "product_research", Personas: []string{"product_research"}, BizLines: []string{"whatsapp"}, WritableBizLines: []string{"whatsapp"},
	}})
	defer httpx.SetUserAuthenticator(nil)
	deliveryService := &recordingDeliveryService{}
	router := gin.New()
	NewHandler(deliveryService, &recordingIdentityService{}, &noBusinessService{}, nil).Register(router.Group("/api"))

	post := func(path, body string) int {
		request := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
		request.Header.Set("token", "valid")
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder.Code
	}

	if code := post("/api/delivery/requirement/name/update", `{"programId":16,"requirementKey":"req-1","name":"req-1","replaceName":""}`); code != http.StatusOK {
		t.Fatalf("需求改名未注册或被拒：status=%d", code)
	}
	if deliveryService.renamed.ActorID != "42" || deliveryService.renamed.BizLine != contract.BizLine("whatsapp") {
		t.Fatalf("需求改名未使用认证上下文：%#v", deliveryService.renamed)
	}

	if code := post("/api/delivery/requirement/git-branch/bind", `{"programId":16,"requirementKey":"req-1","gitBaseBranch":"main","gitBranch":"feature/issue_req-1"}`); code != http.StatusOK {
		t.Fatalf("分支关联未注册或被拒：status=%d", code)
	}
	if deliveryService.bound.ActorID != "42" || deliveryService.bound.BizLine != contract.BizLine("whatsapp") || deliveryService.bound.GitBranch != "feature/issue_req-1" {
		t.Fatalf("分支关联未使用认证上下文：%#v", deliveryService.bound)
	}
}

// 消息中心的收件人必须由凭证认定：请求体里带别人的身份也不能影响结果，
// 否则任何人都能替别人把提醒标成已读。
func TestNotificationRoutesDeriveRecipientFromCredential(t *testing.T) {
	gin.SetMode(gin.TestMode)
	httpx.SetUserAuthenticator(testAuthenticator{principal: httpx.UserPrincipal{
		ID: "42", Persona: "product_research", Personas: []string{"product_research"}, BizLines: []string{"whatsapp"}, WritableBizLines: []string{"whatsapp"},
	}})
	defer httpx.SetUserAuthenticator(nil)
	deliveryService := &recordingDeliveryService{}
	router := gin.New()
	NewHandler(deliveryService, &recordingIdentityService{}, &noBusinessService{}, nil).Register(router.Group("/api"))

	call := func(method, path, body string) int {
		var request *http.Request
		if body == "" {
			request = httptest.NewRequest(method, path, nil)
		} else {
			request = httptest.NewRequest(method, path, bytes.NewBufferString(body))
			request.Header.Set("Content-Type", "application/json")
		}
		request.Header.Set("token", "valid")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder.Code
	}

	if code := call(http.MethodGet, "/api/delivery/execution-batch/notifications?programId=16", ""); code != http.StatusOK {
		t.Fatalf("批次提醒列表未注册或被拒：status=%d", code)
	}
	if deliveryService.batchNotificationQuery.ActorID != "42" || deliveryService.batchNotificationQuery.ProgramID != 16 {
		t.Fatalf("批次提醒列表未使用认证上下文：%#v", deliveryService.batchNotificationQuery)
	}

	if code := call(http.MethodGet, "/api/delivery/requirement/completion-notifications?programId=16", ""); code != http.StatusOK {
		t.Fatalf("需求完成提醒列表未注册或被拒：status=%d", code)
	}
	if deliveryService.completionNotificationQuery.ActorID != "42" {
		t.Fatalf("需求完成提醒列表未使用认证上下文：%#v", deliveryService.completionNotificationQuery)
	}

	// 请求体里塞一个别人的 actorId，服务端仍应认凭证里的 42。
	if code := call(http.MethodPost, "/api/delivery/execution-batch/notification/read", `{"programId":16,"batchId":"batch-1","actorId":"99"}`); code != http.StatusOK {
		t.Fatalf("批次提醒已读未注册或被拒：status=%d", code)
	}
	if deliveryService.batchNotificationRead.ActorID != "42" || deliveryService.batchNotificationRead.BizLine != contract.BizLine("whatsapp") {
		t.Fatalf("批次提醒已读被请求体里的身份影响：%#v", deliveryService.batchNotificationRead)
	}

	if code := call(http.MethodPost, "/api/delivery/requirement/completion-notification/read", `{"programId":16,"requirementKey":"req-1","actorId":"99"}`); code != http.StatusOK {
		t.Fatalf("需求完成提醒已读未注册或被拒：status=%d", code)
	}
	if deliveryService.completionNotificationRead.ActorID != "42" || deliveryService.completionNotificationRead.RequirementKey != "req-1" {
		t.Fatalf("需求完成提醒已读被请求体里的身份影响：%#v", deliveryService.completionNotificationRead)
	}
}
