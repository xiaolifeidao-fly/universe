package businessassistant

import (
	"strings"
	"time"

	"service/business"
)

// Config is the deployment-level description of how one interview turn travels.
// Every field comes from the `business.kodes.*` properties, so the console and
// the mobile API read the same keys out of their own configuration files.
type Config struct {
	// Transport picks the transport. The default is the standing interview
	// host at RemoteURL: it is already deployed and answers turns directly.
	// Only an explicit "command" hands the turn to a plugin Worker over the
	// delivery command queue instead, for a deployment where no interview host
	// is reachable from this server.
	Transport       string
	RemoteURL       string
	WorkerUserID    string
	Model           string
	ReasoningEffort string
	Timeout         time.Duration
}

// New builds the assistant an API binary injects into service/business.
//
// The transport choice lives here rather than in each main: the console and the
// mobile API talk to the same requirements in the same database, so a business
// user must not get a different interview depending on which client raised it.
//
// A missing or unrecognised transport resolves to the interview host, never to
// the command queue: an unconfigured deployment should fail against a host it
// can name, not quietly park every turn in a queue waiting for a Worker.
func New(config Config, commands BusinessCommandPort) business.Assistant {
	if strings.EqualFold(strings.TrimSpace(config.Transport), "command") {
		return &BusinessCommandAssistant{
			Service:         commands,
			WorkerUserID:    strings.TrimSpace(config.WorkerUserID),
			StartTimeout:    config.Timeout,
			Model:           config.Model,
			ReasoningEffort: config.ReasoningEffort,
		}
	}
	return NewBusinessAssistant(config.RemoteURL, config.Model, config.ReasoningEffort, config.Timeout)
}
