package documents

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"common/middleware/httpx"
	"common/objectstore"
	"contract"
	"service/delivery/dto"

	"github.com/gin-gonic/gin"
)

type testAuthenticator struct{ principal httpx.UserPrincipal }

func (a testAuthenticator) AuthenticateToken(context.Context, string) (httpx.UserPrincipal, error) {
	return a.principal, nil
}

type testDirectory struct{ file dto.CloudSyncFileView }

func (d testDirectory) ResolveProgramBizLine(context.Context, int64) (contract.BizLine, error) {
	return contract.BizLine("whatsapp"), nil
}

func (d testDirectory) ListCloudSyncFiles(context.Context, dto.CloudSyncFileQuery) ([]dto.CloudSyncFileView, error) {
	return []dto.CloudSyncFileView{d.file}, nil
}

func (d testDirectory) GetCloudSyncFile(context.Context, contract.BizLine, int64, string, string) (dto.CloudSyncFileView, error) {
	return d.file, nil
}

type testObjectReader struct{ reads int }

func (r *testObjectReader) Get(context.Context, string) (objectstore.ObjectContent, error) {
	r.reads++
	return objectstore.ObjectContent{ContentType: "text/markdown", Data: []byte("# mobile document")}, nil
}

func (r *testObjectReader) SignedURL(string, time.Time) (string, error) {
	return "https://oss.example/signed", nil
}

func TestPreviewRequiresProjectPermissionAndDoesNotExposeObjectKey(t *testing.T) {
	gin.SetMode(gin.TestMode)
	httpx.SetUserAuthenticator(testAuthenticator{principal: httpx.UserPrincipal{
		ID: "42", Persona: "product_research", Personas: []string{"product_research"}, ProgramIDs: []int64{7},
	}})
	defer httpx.SetUserAuthenticator(nil)
	objects := &testObjectReader{}
	router := gin.New()
	NewHandler(testDirectory{file: dto.CloudSyncFileView{
		ProgramID: 7, Category: "design", RelativePath: "design/mobile.md", ContentType: "text/markdown", ObjectKey: "private-key",
	}}, objects).Register(router.Group("/api"))

	allowed := httptest.NewRequest(http.MethodGet, "/api/documents/preview?programId=7&category=design&relativePath=design/mobile.md", nil)
	allowed.Header.Set("token", "valid")
	allowedRecorder := httptest.NewRecorder()
	router.ServeHTTP(allowedRecorder, allowed)
	if allowedRecorder.Code != http.StatusOK || allowedRecorder.Body.String() != "# mobile document" || objects.reads != 1 {
		t.Fatalf("授权预览失败：status=%d body=%q reads=%d", allowedRecorder.Code, allowedRecorder.Body.String(), objects.reads)
	}

	denied := httptest.NewRequest(http.MethodGet, "/api/documents/preview?programId=8&category=design&relativePath=design/mobile.md", nil)
	denied.Header.Set("token", "valid")
	deniedRecorder := httptest.NewRecorder()
	router.ServeHTTP(deniedRecorder, denied)
	if deniedRecorder.Code != http.StatusOK || objects.reads != 1 {
		t.Fatalf("越权读取不得命中 OSS：status=%d reads=%d", deniedRecorder.Code, objects.reads)
	}

	listing := httptest.NewRequest(http.MethodGet, "/api/documents?programId=7", nil)
	listing.Header.Set("token", "valid")
	listingRecorder := httptest.NewRecorder()
	router.ServeHTTP(listingRecorder, listing)
	if listingRecorder.Code != http.StatusOK || string(listingRecorder.Body.Bytes()) == "" || contains(listingRecorder.Body.String(), "private-key") {
		t.Fatalf("文档目录不能泄露对象键：%s", listingRecorder.Body.String())
	}
}

func contains(value, target string) bool {
	for index := 0; index+len(target) <= len(value); index++ {
		if value[index:index+len(target)] == target {
			return true
		}
	}
	return false
}
