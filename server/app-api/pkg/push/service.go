// Package push owns the app-api-specific Web Push subscription registry.
// Delivery command state remains in service/delivery; this package only sends
// best-effort user notifications after that state has already been committed.
package push

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"service/delivery"
	"service/delivery/dto"

	"github.com/SherClockHolmes/webpush-go"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	maxEndpointLength = 2048
	maxKeyLength      = 512
)

type Config struct {
	VAPIDPublicKey  string
	VAPIDPrivateKey string
	VAPIDSubject    string
}

type ConfigView struct {
	Enabled              bool   `json:"enabled"`
	ApplicationServerKey string `json:"applicationServerKey"`
}

type SubscriptionRequest struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256DH string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

type subscription struct {
	ID           int64     `gorm:"column:id;primaryKey;autoIncrement"`
	UserID       string    `gorm:"column:user_id;type:varchar(64);index:idx_app_push_subscription_user,priority:1"`
	Endpoint     string    `gorm:"column:endpoint;type:varchar(2048)"`
	EndpointHash string    `gorm:"column:endpoint_hash;type:char(64);uniqueIndex:uk_app_push_subscription_endpoint"`
	P256DH       string    `gorm:"column:p256dh;type:varchar(512)"`
	Auth         string    `gorm:"column:auth;type:varchar(512)"`
	CreatedTime  time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime  time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (subscription) TableName() string { return "zt_app_push_subscription" }

type Sender interface {
	Send(context.Context, webpush.Subscription, []byte, webpush.Options) (int, error)
}

type serviceSender struct{}

func (serviceSender) Send(_ context.Context, subscription webpush.Subscription, payload []byte, options webpush.Options) (int, error) {
	response, err := webpush.SendNotification(payload, &subscription, &options)
	if response == nil {
		return 0, err
	}
	defer response.Body.Close()
	return response.StatusCode, err
}

type Service struct {
	db     *gorm.DB
	config Config
	sender Sender
	now    func() time.Time
}

func New(database *gorm.DB, config Config) *Service {
	return NewWithSender(database, config, serviceSender{})
}

func NewWithSender(database *gorm.DB, config Config, sender Sender) *Service {
	return &Service{
		db: database,
		config: Config{
			VAPIDPublicKey: strings.TrimSpace(config.VAPIDPublicKey), VAPIDPrivateKey: strings.TrimSpace(config.VAPIDPrivateKey), VAPIDSubject: strings.TrimSpace(config.VAPIDSubject),
		},
		sender: sender,
		now:    time.Now,
	}
}

func (s *Service) Config() ConfigView {
	return ConfigView{Enabled: s.Enabled(), ApplicationServerKey: s.config.VAPIDPublicKey}
}

func (s *Service) Enabled() bool {
	return s != nil && s.db != nil && s.sender != nil && s.config.VAPIDPublicKey != "" && s.config.VAPIDPrivateKey != "" && s.config.VAPIDSubject != ""
}

func (s *Service) Subscribe(ctx context.Context, userID string, req SubscriptionRequest) error {
	if !s.Enabled() {
		return errors.New("Web Push 未配置")
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return errors.New("无法识别当前用户")
	}
	endpoint, p256dh, auth, err := normalizeSubscription(req)
	if err != nil {
		return err
	}
	row := subscription{UserID: userID, Endpoint: endpoint, EndpointHash: endpointHash(endpoint), P256DH: p256dh, Auth: auth}
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "endpoint_hash"}},
		DoUpdates: clause.AssignmentColumns([]string{"user_id", "endpoint", "p256dh", "auth", "updated_time"}),
	}).Create(&row).Error
}

func (s *Service) Unsubscribe(ctx context.Context, userID, endpoint string) error {
	userID = strings.TrimSpace(userID)
	endpoint = strings.TrimSpace(endpoint)
	if userID == "" || endpoint == "" {
		return errors.New("缺少订阅标识")
	}
	return s.db.WithContext(ctx).Where("user_id = ? AND endpoint_hash = ?", userID, endpointHash(endpoint)).Delete(&subscription{}).Error
}

// NotifyCommandTerminal delivers only terminal states. Failure to deliver or a
// stale subscription cannot change the command's already-authoritative result.
func (s *Service) NotifyCommandTerminal(ctx context.Context, command dto.CommandView) {
	if !s.Enabled() || strings.TrimSpace(command.UserID) == "" {
		return
	}
	payload, ok := commandPayload(command)
	if !ok {
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	var subscriptions []subscription
	if err := s.db.WithContext(ctx).Where("user_id = ?", command.UserID).Find(&subscriptions).Error; err != nil {
		return
	}
	options := webpush.Options{
		Subscriber: s.config.VAPIDSubject, VAPIDPublicKey: s.config.VAPIDPublicKey, VAPIDPrivateKey: s.config.VAPIDPrivateKey, TTL: 60,
	}
	for _, row := range subscriptions {
		status, _ := s.sender.Send(ctx, webpush.Subscription{
			Endpoint: row.Endpoint, Keys: webpush.Keys{P256dh: row.P256DH, Auth: row.Auth},
		}, body, options)
		if status == 404 || status == 410 {
			_ = s.db.WithContext(ctx).Where("endpoint_hash = ?", row.EndpointHash).Delete(&subscription{}).Error
		}
	}
}

func normalizeSubscription(req SubscriptionRequest) (string, string, string, error) {
	endpoint := strings.TrimSpace(req.Endpoint)
	if endpoint == "" || utf8.RuneCountInString(endpoint) > maxEndpointLength {
		return "", "", "", errors.New("Web Push endpoint 无效")
	}
	parsed, err := url.ParseRequestURI(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return "", "", "", errors.New("Web Push endpoint 必须是 HTTPS 地址")
	}
	p256dh := strings.TrimSpace(req.Keys.P256DH)
	auth := strings.TrimSpace(req.Keys.Auth)
	if p256dh == "" || auth == "" || utf8.RuneCountInString(p256dh) > maxKeyLength || utf8.RuneCountInString(auth) > maxKeyLength {
		return "", "", "", errors.New("Web Push 订阅密钥无效")
	}
	return endpoint, p256dh, auth, nil
}

func endpointHash(endpoint string) string {
	sum := sha256.Sum256([]byte(endpoint))
	return hex.EncodeToString(sum[:])
}

type notificationPayload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Tag   string `json:"tag"`
	Data  struct {
		Kind           string `json:"kind"`
		CommandID      string `json:"commandId"`
		ProgramID      int64  `json:"programId"`
		CommandType    string `json:"commandType"`
		ItemKey        string `json:"itemKey,omitempty"`
		RequirementKey string `json:"requirementKey,omitempty"`
		State          string `json:"state"`
		URL            string `json:"url"`
	} `json:"data"`
}

// 只有「用户按下去、然后要等」的命令值得响一次。会话页每几秒读一次快照、停止
// 请求本身、以及服务端替业务访谈发起的回合都不该把手机点亮 —— 一轮拆解期间光是
// 快照命令就有上百条，全推等于把通知栏变成噪音，用户下次会直接关掉权限。
func notifiableCommand(commandType string) bool {
	commandType = strings.ToLower(strings.TrimSpace(commandType))
	if delivery.IsReadOnlyCommand(commandType) || strings.HasPrefix(commandType, "business.") {
		return false
	}
	switch commandType {
	case "task.stop", "task.stop-all", "task.planning-stop":
		return false
	}
	return true
}

func commandPayload(command dto.CommandView) (notificationPayload, bool) {
	if !notifiableCommand(command.CommandType) {
		return notificationPayload{}, false
	}
	var payload notificationPayload
	payload.Tag = "delivery-command-" + command.CommandID
	payload.Data.CommandID = command.CommandID
	payload.Data.ProgramID = command.ProgramID
	payload.Data.CommandType = command.CommandType
	payload.Data.State = command.State
	payload.Data.ItemKey, payload.Data.RequirementKey = commandTargets(command.Input)
	payload.Data.URL = commandNotificationURL(command, payload.Data.ItemKey, payload.Data.RequirementKey)
	switch command.State {
	case "succeeded":
		if command.CommandType == "task.conversation" {
			payload.Title = "AI 回复已完成"
			payload.Body = fallbackMessage(payload.Data.ItemKey, "任务会话已有新回复")
			payload.Data.Kind = "ai_reply_completed"
		} else {
			payload.Title = "任务已完成"
			payload.Body = fallbackMessage(payload.Data.ItemKey, "远程任务已完成")
			payload.Data.Kind = "command_completed"
		}
	case "failed":
		if commandIsBlocked(command) {
			payload.Title = "任务被阻塞"
			payload.Body = fallbackMessage(command.ErrorMessage, "远程任务需要处理")
			payload.Data.Kind = "command_blocked"
		} else {
			payload.Title = "任务失败"
			payload.Body = fallbackMessage(command.ErrorMessage, "远程任务执行失败")
			payload.Data.Kind = "command_failed"
		}
	case "timed_out":
		payload.Title = "任务失败"
		payload.Body = "远程任务等待 Worker 超时"
		payload.Data.Kind = "command_failed"
	default:
		return notificationPayload{}, false
	}
	return payload, true
}

func commandTargets(raw json.RawMessage) (itemKey, requirementKey string) {
	var input struct {
		ItemKey        string `json:"itemKey"`
		RequirementKey string `json:"requirementKey"`
	}
	if json.Unmarshal(raw, &input) != nil {
		return "", ""
	}
	return strings.TrimSpace(input.ItemKey), strings.TrimSpace(input.RequirementKey)
}

// commandNotificationURL 把通知落在用户真正要去的那一屏。
//
// 点开一条「AI 回复已完成」，想看的是那段回复，而不是一张命令列表 —— 会话类命令
// 因此直落对应的对话页。落不到具体会话的（批量执行、Git 写操作）才回运行记录，
// 在那里能看到进度、活动和结果。
func commandNotificationURL(command dto.CommandView, itemKey, requirementKey string) string {
	program := strconv.FormatInt(command.ProgramID, 10)
	switch command.CommandType {
	case "task.planning", "task.planning-stop":
		if requirementKey != "" {
			return "/workbench/requirements/" + url.PathEscape(requirementKey) + "/chat?programId=" + program
		}
	case "task.conversation", "task.execute", "task.stop":
		if itemKey != "" {
			return "/workbench/tasks/" + url.PathEscape(itemKey) + "/chat?programId=" + program
		}
	}
	query := url.Values{}
	query.Set("commandId", command.CommandID)
	query.Set("programId", program)
	if itemKey != "" {
		query.Set("itemKey", itemKey)
	}
	if requirementKey != "" {
		query.Set("requirementKey", requirementKey)
	}
	return "/commands?" + query.Encode()
}

func commandIsBlocked(command dto.CommandView) bool {
	message := strings.ToLower(command.ErrorMessage)
	if strings.Contains(message, "blocked") || strings.Contains(command.ErrorMessage, "阻塞") {
		return true
	}
	var result map[string]any
	if json.Unmarshal(command.Result, &result) != nil {
		return false
	}
	if blocked, ok := result["blocked"].(bool); ok && blocked {
		return true
	}
	status, _ := result["status"].(string)
	return strings.EqualFold(strings.TrimSpace(status), "blocked")
}

func fallbackMessage(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}
