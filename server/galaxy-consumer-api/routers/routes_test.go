package routers

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	shared "galaxy-common/auth"
	"galaxy-common/bootstrap"
	"galaxy-common/metrics"
	"galaxy-consumer-api/pkg/auth"
	"galaxy-consumer-api/pkg/consumers"
	"galaxy-consumer-api/pkg/portal"
	"service/galaxy"
)

type routeService struct{ galaxy.Service }

func (routeService) PaymentEnabled() bool { return true }
func TestOwnedRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	service := routeService{}
	base := &bootstrap.Assembly{Galaxy: service, Metrics: metrics.New()}
	gate := shared.NewGate(nil)
	assembly := &Assembly{Assembly: base, Auth: auth.NewHandler(nil, gate), Consumers: consumers.NewHandler(service, gate, consumers.Options{}), Portal: portal.NewHandler(service, portal.Options{})}
	engine := route(assembly, nil)
	registered := map[string]bool{}
	absent := []string{"/agent", "/v1", "/api/galaxy/provider"}
	for _, r := range engine.Routes() {
		registered[r.Method+" "+r.Path] = true
		for _, prefix := range absent {
			if strings.HasPrefix(r.Path, prefix) {
				t.Errorf("unexpected route %s", r.Path)
			}
		}
	}
	for _, r := range []string{"POST /api/galaxy/consumer/auth/login", "POST /api/galaxy/consumer/auth/register", "GET /api/galaxy/consumer/keys", "POST /api/galaxy/consumer/keys", "GET /api/galaxy/portal/overview", "GET /api/galaxy/desktop/update-feed"} {
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
