package routers

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"galaxy-api/pkg/auth"
	"galaxy-api/pkg/providers"
	shared "galaxy-common/auth"
	"galaxy-common/bootstrap"
	"galaxy-common/metrics"
	"service/galaxy"
)

type routeService struct{ galaxy.Service }

func (routeService) PaymentEnabled() bool { return true }
func TestOwnedRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	service := routeService{}
	base := &bootstrap.Assembly{Galaxy: service, Metrics: metrics.New()}
	gate := shared.NewGate(nil)
	assembly := &Assembly{Assembly: base, Auth: auth.NewHandler(nil, gate), Providers: providers.NewHandler(service, gate)}
	engine := route(assembly)
	registered := map[string]bool{}
	absent := []string{"/agent", "/v1", "/api/galaxy/consumer", "/api/galaxy/portal", "/galaxy/payments"}
	for _, r := range engine.Routes() {
		registered[r.Method+" "+r.Path] = true
		for _, prefix := range absent {
			if strings.HasPrefix(r.Path, prefix) {
				t.Errorf("unexpected route %s", r.Path)
			}
		}
	}
	for _, r := range []string{"POST /api/galaxy/provider/auth/login", "POST /api/galaxy/provider/auth/register", "GET /api/galaxy/provider/nodes"} {
		if !registered[r] {
			t.Errorf("missing route %s", r)
		}
	}
	for _, prefix := range absent {
		rec := httptest.NewRecorder()
		engine.ServeHTTP(rec, httptest.NewRequest("GET", prefix+"/missing", nil))
		if rec.Code != 404 {
			t.Errorf("foreign route %s returned %d", prefix, rec.Code)
		}
	}
}
