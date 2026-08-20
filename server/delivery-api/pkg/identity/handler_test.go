package identity

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"service/bizline"
	bizlinedto "service/bizline/dto"
	identityservice "service/identity"
	identitydto "service/identity/dto"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type registerIdentityService struct {
	identityservice.Service
	result           identitydto.LoginResult
	registerCalls    int
	assignmentCalls  int
	deleteUserCalls  int
	currentUserCalls int
}

func (s *registerIdentityService) Register(_ context.Context, _ identitydto.RegisterRequest) (identitydto.LoginResult, error) {
	s.registerCalls++
	return s.result, nil
}

func (s *registerIdentityService) ReplaceBizLineAssignment(_ context.Context, _ string, _ identitydto.ScopeAssignment) error {
	s.assignmentCalls++
	return nil
}

func (s *registerIdentityService) CurrentUser(_ context.Context, _ int64) (identitydto.UserView, error) {
	s.currentUserCalls++
	return s.result.User, nil
}

func (s *registerIdentityService) DeleteUser(_ context.Context, _ int64, _ string) error {
	s.deleteUserCalls++
	return nil
}

type registerBizLineService struct {
	bizline.Service
	getErr        error
	registerCalls int
}

func (s *registerBizLineService) Get(_ context.Context, _ string) (bizlinedto.BizLineView, error) {
	return bizlinedto.BizLineView{Code: "cay"}, s.getErr
}

func (s *registerBizLineService) Register(_ context.Context, _ bizlinedto.RegisterRequest) error {
	s.registerCalls++
	return nil
}

func TestRegisterKeepsExistingSpaceUnchanged(t *testing.T) {
	gin.SetMode(gin.TestMode)
	identities := &registerIdentityService{result: identitydto.LoginResult{User: identitydto.UserView{ID: 42, Username: "cay", DisplayName: "Cay"}}}
	spaces := &registerBizLineService{}
	recorder := requestRegister(t, NewHandler(identities, spaces))

	if recorder.Code != http.StatusOK || !bytes.Contains(recorder.Body.Bytes(), []byte(`"success":true`)) {
		t.Fatalf("registration response = %s", recorder.Body.String())
	}
	if identities.registerCalls != 1 {
		t.Fatalf("Register calls = %d, want 1", identities.registerCalls)
	}
	if spaces.registerCalls != 0 {
		t.Fatalf("existing space was recreated %d times", spaces.registerCalls)
	}
	if identities.assignmentCalls != 0 {
		t.Fatalf("existing space received %d new assignments", identities.assignmentCalls)
	}
}

func TestRegisterCreatesAndAssignsMissingSpace(t *testing.T) {
	gin.SetMode(gin.TestMode)
	identities := &registerIdentityService{result: identitydto.LoginResult{User: identitydto.UserView{ID: 42, Username: "cay", DisplayName: "Cay"}}}
	spaces := &registerBizLineService{getErr: gorm.ErrRecordNotFound}
	recorder := requestRegister(t, NewHandler(identities, spaces))

	if recorder.Code != http.StatusOK || !bytes.Contains(recorder.Body.Bytes(), []byte(`"success":true`)) {
		t.Fatalf("registration response = %s", recorder.Body.String())
	}
	if spaces.registerCalls != 1 {
		t.Fatalf("space creation calls = %d, want 1", spaces.registerCalls)
	}
	if identities.assignmentCalls != 1 {
		t.Fatalf("assignment calls = %d, want 1", identities.assignmentCalls)
	}
}

func requestRegister(t *testing.T, handler *Handler) *httptest.ResponseRecorder {
	t.Helper()
	engine := gin.New()
	handler.RegisterHandler(engine.Group("/api"))
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/auth/register", bytes.NewBufferString(`{"username":"cay","displayName":"Cay","password":"password123"}`))
	request.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, request)
	return recorder
}
