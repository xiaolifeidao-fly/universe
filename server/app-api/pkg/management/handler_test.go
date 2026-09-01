package management

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"common/middleware/httpx"
	"contract"
	bizlinedto "service/bizline/dto"
	"service/business"
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
}

func (s *recordingDeliveryService) ResolveProgramBizLine(context.Context, int64) (contract.BizLine, error) {
	return contract.BizLine("whatsapp"), nil
}

func (s *recordingDeliveryService) PatchItem(_ context.Context, req deliverydto.PatchItemRequest) (deliverydto.ItemView, error) {
	s.patched = req
	return deliverydto.ItemView{ItemKey: req.ItemKey, ProgramID: req.ProgramID}, nil
}

type recordingIdentityService struct{ identity.Service }

func (s *recordingIdentityService) ListProgramMembers(context.Context, int64) ([]identitydto.MemberView, error) {
	return []identitydto.MemberView{{ID: "member-1", DisplayName: "Mira"}}, nil
}

type noBusinessService struct{ business.Service }

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
