package routers

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"galaxy-common/bootstrap"
	"galaxy-common/metrics"
	corepkg "galaxy-hub-api/adapters/core"
	"galaxy-hub-api/adapters/relay"
	"galaxy-hub-api/pkg/agent"
	"galaxy-hub-api/pkg/bridge"
	"galaxy-hub-api/pkg/native"
	"service/galaxy"
)

type routeService struct{ galaxy.Service }

func (routeService) PaymentEnabled() bool { return true }
func TestOwnedRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	service := routeService{}
	base := &bootstrap.Assembly{Galaxy: service, Metrics: metrics.New()}
	exchange := corepkg.NewExchange()
	journal := corepkg.NewJournal(8, nil)
	assembly := &Assembly{Assembly: base, Exchange: exchange, Journal: journal, Registry: corepkg.NewRegistry(relay.New(&corepkg.Deps{}, relay.Options{})), Agent: agent.NewHandler(service, exchange, journal, 0, nil), Bridge: bridge.NewHandler(service), Native: native.NewHandler(service)}
	engine := route(assembly)
	registered := map[string]bool{}
	absent := []string{"/api/galaxy", "/galaxy/payments"}
	for _, r := range engine.Routes() {
		registered[r.Method+" "+r.Path] = true
		for _, prefix := range absent {
			if strings.HasPrefix(r.Path, prefix) {
				t.Errorf("unexpected route %s", r.Path)
			}
		}
	}
	for _, r := range []string{"POST /v1/chat/completions", "POST /v1/messages", "GET /v1/models", "GET /v1/keys/me", "POST /v1/artifacts", "GET /v1/artifacts/*objectKey", "GET /v1/usage", "POST /v1/orders", "POST /v1/keys/:keyId/renew", "POST /agent/v1/register", "POST /agent/v1/heartbeat", "POST /agent/v1/next", "POST /agent/v1/units/:unitId/stream", "GET /agent/v1/bridge/install.sh"} {
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
