package delivery

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"

	"gorm.io/gorm"
)

// CommandService is deliberately separate from the board API. app-api only needs
// this narrow surface, while all mutation authority stays inside delivery.
type CommandService interface {
	SubmitCommand(context.Context, dto.SubmitCommandRequest) (dto.CommandView, error)
	ListCommands(context.Context, dto.CommandQuery) (dto.CommandPage, error)
	GetCommand(context.Context, contract.BizLine, string, string) (dto.CommandView, error)
	RequestCommandCancellation(context.Context, dto.CancelCommandRequest) (dto.CommandView, error)
	RegisterCommandWorker(context.Context, dto.RegisterCommandWorkerRequest) (dto.CommandWorkerView, error)
	HeartbeatCommandWorker(context.Context, dto.WorkerHeartbeatRequest) error
	ClaimCommand(context.Context, dto.ClaimCommandRequest) (*dto.ClaimedCommand, error)
	RenewCommandLease(context.Context, dto.RenewCommandLeaseRequest) (dto.CommandView, error)
	ReportCommandActivity(context.Context, dto.ReportCommandActivityRequest) (dto.CommandView, error)
	CompleteCommand(context.Context, dto.CompleteCommandRequest) (dto.CommandView, error)
	ListCommandEvents(context.Context, dto.CommandEventQuery) ([]dto.CommandEventView, error)
	// ResolveCommandWorkerUser answers which console user's Worker serves a project.
	// Server-initiated commands have no console identity and file under that owner.
	ResolveCommandWorkerUser(context.Context, contract.BizLine, int64) (string, error)
	// LatestCommandActivity returns the newest activity a Worker reported, or an
	// empty view when it has not reported one yet.
	LatestCommandActivity(context.Context, contract.BizLine, string, string) (dto.CommandEventView, error)
	ReconcileExpiredCommands(context.Context) ([]dto.CommandView, error)
	// PurgeFinishedCommands 按类型分档清掉已终态的命令与事件行，让快照命令不至于
	// 把命令表当日志表用。
	PurgeFinishedCommands(context.Context) (int64, error)
	// GetCommandWorkerStatus 回答某个项目当前有没有在线的执行电脑。
	GetCommandWorkerStatus(context.Context, contract.BizLine, string, int64) (dto.CommandWorkerStatusView, error)
	SaveCommandAttachments(context.Context, dto.SaveCommandAttachmentsRequest) ([]dto.CommandAttachmentView, error)
	GetCommandAttachment(context.Context, contract.BizLine, string, int64, string) (dto.CommandAttachmentContent, error)
}

func (s *service) SubmitCommand(ctx context.Context, req dto.SubmitCommandRequest) (dto.CommandView, error) {
	if !req.BizLine.Valid() {
		return dto.CommandView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || strings.TrimSpace(req.UserID) == "" {
		return dto.CommandView{}, errors.New("缺少项目或用户标识")
	}
	commandType, err := normalizeCommandType(req.CommandType)
	if err != nil {
		return dto.CommandView{}, err
	}
	idempotencyKey, err := normalizeIdempotencyKey(req.IdempotencyKey)
	if err != nil {
		return dto.CommandView{}, err
	}
	input, err := normalizeCommandJSONObject(req.Input, maxCommandInputBytes, "命令输入")
	if err != nil {
		return dto.CommandView{}, err
	}
	if _, err := s.repo.FindProgram(ctx, req.BizLine.String(), req.ProgramID); err != nil {
		return dto.CommandView{}, translate(err)
	}
	if err := s.requireOnlineCommandWorker(ctx, req.BizLine, req.UserID, req.ProgramID); err != nil {
		return dto.CommandView{}, err
	}
	if existing, err := s.repo.FindCommandByIdempotency(ctx, req.BizLine.String(), req.UserID, idempotencyKey); err == nil {
		return toCommandView(existing), nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return dto.CommandView{}, err
	}
	row := &repository.DeliveryCommand{
		BizLine: req.BizLine.String(), CommandID: generateCommandID(), ProgramID: req.ProgramID, UserID: req.UserID,
		CommandType: commandType, IdempotencyKey: idempotencyKey, InputJSON: input, ResultJSON: "{}", State: CommandStatePending, DispatchCount: 1,
	}
	event := &repository.DeliveryCommandEvent{BizLine: row.BizLine, CommandID: row.CommandID, UserID: row.UserID, Kind: "submitted", State: row.State, Message: "命令已提交，等待已注册插件领取", DataJSON: "{}"}
	if err := s.repo.CreateCommand(ctx, row, event); err != nil {
		// The unique idempotency index makes concurrent retries converge to the same
		// command instead of starting two local executions.
		if existing, lookupErr := s.repo.FindCommandByIdempotency(ctx, req.BizLine.String(), req.UserID, idempotencyKey); lookupErr == nil {
			return toCommandView(existing), nil
		}
		return dto.CommandView{}, err
	}
	s.notifyPendingCommand(ctx, row.UserID, row.CommandID)
	return toCommandView(row), nil
}

// requireOnlineCommandWorker 在提交之前就把「执行电脑不在线」挡回去。
//
// 让命令排在队列里等插件上线，看着像「已提交」，实际是把几分钟后才发生的写操作藏
// 起来：用户以为这一轮没成功，它却在后面自己跑了。读取类命令同样挡 —— 与其让界面
// 转够九十秒再说超时，不如当场说清插件没开。
func (s *service) requireOnlineCommandWorker(ctx context.Context, bizLine contract.BizLine, userID string, programID int64) error {
	row, err := s.repo.FindLatestCommandWorker(ctx, bizLine.String(), userID, programID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return errors.New("这个项目还没有登记执行电脑，请先在项目所在的电脑上启动插件桥接")
	}
	if err != nil {
		return err
	}
	if !commandWorkerOnline(row.LastHeartbeatAt, time.Now()) {
		return fmt.Errorf("%s当前离线（最后心跳 %s），请先在那台电脑上启动插件桥接后重试",
			commandWorkerName(row.DisplayName), lastHeartbeatLabel(row.LastHeartbeatAt))
	}
	return nil
}

func commandWorkerName(displayName string) string {
	name := strings.TrimSpace(displayName)
	if name == "" {
		return "执行电脑"
	}
	return "执行电脑「" + name + "」"
}

// lastHeartbeatLabel 只给量级：用户要判断的是「刚断还是早就没开」，不是精确到秒。
func lastHeartbeatLabel(lastHeartbeatAt time.Time) string {
	if lastHeartbeatAt.IsZero() {
		return "未知"
	}
	minutes := int(time.Since(lastHeartbeatAt).Minutes())
	if minutes < 1 {
		return "刚刚"
	}
	if minutes < 60 {
		return fmt.Sprintf("%d 分钟前", minutes)
	}
	if minutes < 24*60 {
		return fmt.Sprintf("%d 小时前", minutes/60)
	}
	return lastHeartbeatAt.Format(dateLayout)
}

// ResolveCommandWorkerUser is the routing rule for commands the server raises on
// someone else's behalf. Business intake authenticates a business user who never
// registers a Worker, so its turns are dispatched to whichever console user has a
// live Worker mapped to the selected project.
func (s *service) ResolveCommandWorkerUser(ctx context.Context, bizLine contract.BizLine, programID int64) (string, error) {
	if !bizLine.Valid() {
		return "", contract.ErrBizLineRequired
	}
	if programID <= 0 {
		return "", errors.New("缺少项目标识")
	}
	userID, err := s.repo.FindCommandWorkerUserForProgram(ctx, bizLine.String(), programID, time.Now().Add(-commandWorkerOnlineWindow))
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", errors.New("当前项目没有在线的本机插件，请先在任务面板所在电脑启动插件桥接")
	}
	if err != nil {
		return "", err
	}
	return userID, nil
}

func (s *service) LatestCommandActivity(ctx context.Context, bizLine contract.BizLine, userID, commandID string) (dto.CommandEventView, error) {
	if !bizLine.Valid() {
		return dto.CommandEventView{}, contract.ErrBizLineRequired
	}
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(commandID) == "" {
		return dto.CommandEventView{}, errors.New("缺少用户或命令标识")
	}
	row, err := s.repo.FindLatestCommandActivity(ctx, bizLine.String(), userID, commandID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return dto.CommandEventView{}, nil
	}
	if err != nil {
		return dto.CommandEventView{}, err
	}
	return dto.CommandEventView{ID: row.Id, Kind: row.Kind, State: row.State, Message: row.Message, Data: rawJSONObject(row.DataJSON), CreatedAt: row.CreatedAt}, nil
}

func (s *service) ListCommands(ctx context.Context, query dto.CommandQuery) (dto.CommandPage, error) {
	if !query.BizLine.Valid() {
		return dto.CommandPage{}, contract.ErrBizLineRequired
	}
	if strings.TrimSpace(query.UserID) == "" {
		return dto.CommandPage{}, errors.New("缺少用户标识")
	}
	if query.State != "" {
		if _, ok := commandStates[strings.TrimSpace(query.State)]; !ok {
			return dto.CommandPage{}, fmt.Errorf("未知的命令状态：%s", query.State)
		}
	}
	excluded := readOnlyCommandTypeList()
	if query.IncludeReadOnly {
		excluded = nil
	}
	rows, total, err := s.repo.ListCommands(ctx, repository.CommandQuery{
		BizLine: query.BizLine.String(), UserID: query.UserID, ProgramID: query.ProgramID,
		State: strings.TrimSpace(query.State), ExcludeCommandTypes: excluded, Offset: query.Offset(), Limit: query.Limit(),
	})
	if err != nil {
		return dto.CommandPage{}, err
	}
	views := make([]dto.CommandView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toCommandView(row))
	}
	return dto.CommandPage{Total: total, Data: views}, nil
}

func (s *service) GetCommand(ctx context.Context, bizLine contract.BizLine, userID, commandID string) (dto.CommandView, error) {
	if !bizLine.Valid() {
		return dto.CommandView{}, contract.ErrBizLineRequired
	}
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(commandID) == "" {
		return dto.CommandView{}, errors.New("缺少用户或命令标识")
	}
	row, err := s.repo.FindCommand(ctx, bizLine.String(), userID, commandID)
	if err != nil {
		return dto.CommandView{}, translate(err)
	}
	return toCommandView(row), nil
}

func (s *service) SaveCommandAttachments(ctx context.Context, req dto.SaveCommandAttachmentsRequest) ([]dto.CommandAttachmentView, error) {
	if !req.BizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || strings.TrimSpace(req.UserID) == "" {
		return nil, errors.New("缺少项目或用户标识")
	}
	itemKey := strings.TrimSpace(req.ItemKey)
	if itemKey == "" || utf8.RuneCountInString(itemKey) > 128 {
		return nil, errors.New("任务标识无效")
	}
	if len(req.Uploads) == 0 || len(req.Uploads) > maxCommandAttachmentCount {
		return nil, fmt.Errorf("一次最多上传 %d 个附件", maxCommandAttachmentCount)
	}
	if _, err := s.repo.FindProgram(ctx, req.BizLine.String(), req.ProgramID); err != nil {
		return nil, translate(err)
	}
	rows := make([]*repository.DeliveryCommandAttachment, 0, len(req.Uploads))
	var total int
	for _, upload := range req.Uploads {
		name := safeCommandAttachmentName(upload.Name)
		if len(upload.Content) == 0 {
			return nil, fmt.Errorf("附件 %s 为空", name)
		}
		if len(upload.Content) > maxCommandAttachmentBytes {
			return nil, fmt.Errorf("附件 %s 超过 20 MB", name)
		}
		total += len(upload.Content)
		if total > maxCommandAttachmentTotalBytes {
			return nil, errors.New("附件总大小超过 100 MB")
		}
		contentType := strings.TrimSpace(upload.ContentType)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		if utf8.RuneCountInString(contentType) > 128 {
			return nil, fmt.Errorf("附件 %s 的类型无效", name)
		}
		rows = append(rows, &repository.DeliveryCommandAttachment{
			BizLine: req.BizLine.String(), AttachmentID: generateCommandAttachmentID(), ProgramID: req.ProgramID,
			UserID: req.UserID, ItemKey: itemKey, Name: name, ContentType: contentType,
			Size: int64(len(upload.Content)), Content: upload.Content,
		})
	}
	if err := s.repo.CreateCommandAttachments(ctx, rows); err != nil {
		return nil, err
	}
	views := make([]dto.CommandAttachmentView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toCommandAttachmentView(row))
	}
	return views, nil
}

func (s *service) GetCommandAttachment(
	ctx context.Context, bizLine contract.BizLine, userID string, programID int64, attachmentID string,
) (dto.CommandAttachmentContent, error) {
	if !bizLine.Valid() {
		return dto.CommandAttachmentContent{}, contract.ErrBizLineRequired
	}
	if strings.TrimSpace(userID) == "" || programID <= 0 || !commandAttachmentIDPattern.MatchString(strings.TrimSpace(attachmentID)) {
		return dto.CommandAttachmentContent{}, errors.New("附件标识无效")
	}
	row, err := s.repo.FindCommandAttachment(ctx, bizLine.String(), userID, programID, strings.TrimSpace(attachmentID))
	if err != nil {
		return dto.CommandAttachmentContent{}, translate(err)
	}
	return dto.CommandAttachmentContent{CommandAttachmentView: toCommandAttachmentView(row), Content: row.Content}, nil
}

func (s *service) RequestCommandCancellation(ctx context.Context, req dto.CancelCommandRequest) (dto.CommandView, error) {
	if !req.BizLine.Valid() {
		return dto.CommandView{}, contract.ErrBizLineRequired
	}
	if strings.TrimSpace(req.UserID) == "" || strings.TrimSpace(req.CommandID) == "" {
		return dto.CommandView{}, errors.New("缺少用户或命令标识")
	}
	message := strings.TrimSpace(req.Message)
	if message == "" {
		message = "用户请求取消；正在等待 Worker 尽力停止"
	}
	if utf8.RuneCountInString(message) > 1024 {
		return dto.CommandView{}, errors.New("取消说明不能超过 1024 字符")
	}
	row, _, err := s.repo.RequestCommandCancellation(ctx, req.BizLine.String(), req.UserID, req.CommandID, message)
	if err != nil {
		return dto.CommandView{}, translate(err)
	}
	return toCommandView(row), nil
}

func (s *service) RegisterCommandWorker(ctx context.Context, req dto.RegisterCommandWorkerRequest) (dto.CommandWorkerView, error) {
	if !req.BizLine.Valid() {
		return dto.CommandWorkerView{}, contract.ErrBizLineRequired
	}
	workerID, err := normalizeWorkerID(req.WorkerID)
	if err != nil {
		return dto.CommandWorkerView{}, err
	}
	if strings.TrimSpace(req.UserID) == "" {
		return dto.CommandWorkerView{}, errors.New("缺少用户标识")
	}
	programIDs, err := normalizeProgramIDs(req.ProgramIDs)
	if err != nil {
		return dto.CommandWorkerView{}, err
	}
	for _, programID := range programIDs {
		if _, err := s.repo.FindProgram(ctx, req.BizLine.String(), programID); err != nil {
			return dto.CommandWorkerView{}, translate(err)
		}
	}
	capabilities, err := normalizeCapabilities(req.Capabilities)
	if err != nil {
		return dto.CommandWorkerView{}, err
	}
	capabilitiesJSON, _ := json.Marshal(capabilities)
	displayName := strings.TrimSpace(req.DisplayName)
	if displayName == "" {
		displayName = workerID
	}
	if utf8.RuneCountInString(displayName) > 128 {
		return dto.CommandWorkerView{}, errors.New("Worker 显示名不能超过 128 字符")
	}
	workspaces := make([]*repository.DeliveryCommandWorkerWorkspace, 0, len(programIDs))
	for _, programID := range programIDs {
		workspaces = append(workspaces, &repository.DeliveryCommandWorkerWorkspace{BizLine: req.BizLine.String(), UserID: req.UserID, WorkerID: workerID, ProgramID: programID})
	}
	now := time.Now()
	row := &repository.DeliveryCommandWorker{BizLine: req.BizLine.String(), UserID: req.UserID, WorkerID: workerID, DisplayName: displayName, CapabilitiesJSON: string(capabilitiesJSON), LastHeartbeatAt: now}
	if err := s.repo.UpsertCommandWorker(ctx, row, workspaces); err != nil {
		return dto.CommandWorkerView{}, err
	}
	return dto.CommandWorkerView{BizLine: row.BizLine, WorkerID: row.WorkerID, DisplayName: row.DisplayName, Capabilities: capabilities, ProgramIDs: programIDs, LastHeartbeatAt: now}, nil
}

func (s *service) HeartbeatCommandWorker(ctx context.Context, req dto.WorkerHeartbeatRequest) error {
	if !req.BizLine.Valid() {
		return contract.ErrBizLineRequired
	}
	workerID, err := normalizeWorkerID(req.WorkerID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(req.UserID) == "" {
		return errors.New("缺少用户标识")
	}
	exists, err := s.repo.TouchCommandWorker(ctx, req.BizLine.String(), req.UserID, workerID)
	if err != nil {
		return err
	}
	if !exists {
		return contract.ErrNotFound
	}
	return nil
}

func (s *service) ClaimCommand(ctx context.Context, req dto.ClaimCommandRequest) (*dto.ClaimedCommand, error) {
	workerID, err := normalizeWorkerID(req.WorkerID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.UserID) == "" {
		return nil, errors.New("缺少用户标识")
	}
	if _, err := s.ReconcileExpiredCommands(ctx); err != nil {
		return nil, err
	}
	workspaces, err := s.repo.ListCommandWorkerWorkspaces(ctx, req.UserID, workerID)
	if err != nil {
		return nil, err
	}
	for _, workspace := range workspaces {
		worker, err := s.repo.FindCommandWorker(ctx, workspace.BizLine, req.UserID, workerID)
		if err != nil {
			continue
		}
		capabilities := narrowCommandCapabilities(storedCommandCapabilities(worker.CapabilitiesJSON), req.CommandTypes)
		if len(capabilities) == 0 {
			continue
		}
		for {
			row, err := s.repo.FindNextPendingCommand(ctx, workspace.BizLine, req.UserID, workspace.ProgramID, capabilities)
			if errors.Is(err, gorm.ErrRecordNotFound) {
				break
			}
			if err != nil {
				return nil, err
			}
			if staleReadOnlyCommand(row.CommandType, row.CreatedTime, time.Now()) {
				if _, err := s.repo.AbandonPendingCommand(ctx, row.BizLine, row.UserID, row.CommandID, "界面快照已过期，未再下发执行"); err != nil {
					return nil, err
				}
				continue
			}
			leaseToken := generateLeaseToken()
			expiresAt := time.Now().Add(commandLeaseDuration)
			event := &repository.DeliveryCommandEvent{BizLine: row.BizLine, CommandID: row.CommandID, UserID: row.UserID, Kind: "claimed", State: CommandStateLeased, Message: "Worker 已领取命令", DataJSON: "{}"}
			claimed, err := s.repo.TryLeaseCommand(ctx, row.BizLine, row.UserID, row.CommandID, workerID, leaseToken, expiresAt, event)
			if err != nil {
				return nil, err
			}
			if !claimed {
				continue
			}
			row.State = CommandStateLeased
			row.LeaseWorkerID = workerID
			row.LeaseExpiresAt = &expiresAt
			row.AttemptCount++
			_, _ = s.repo.TouchCommandWorker(ctx, workspace.BizLine, req.UserID, workerID)
			return &dto.ClaimedCommand{Command: toCommandView(row), LeaseToken: leaseToken}, nil
		}
	}
	return nil, nil
}

func (s *service) RenewCommandLease(ctx context.Context, req dto.RenewCommandLeaseRequest) (dto.CommandView, error) {
	if err := validateLeasedCommand(req.BizLine, req.UserID, req.WorkerID, req.CommandID, req.LeaseToken); err != nil {
		return dto.CommandView{}, err
	}
	current, err := s.GetCommand(ctx, req.BizLine, req.UserID, req.CommandID)
	if err != nil {
		return dto.CommandView{}, err
	}
	expiresAt := time.Now().Add(commandLeaseDuration)
	updated, err := s.repo.UpdateActiveCommand(ctx, req.BizLine.String(), req.UserID, req.CommandID, req.WorkerID, req.LeaseToken,
		map[string]any{"lease_expires_at": expiresAt},
		&repository.DeliveryCommandEvent{BizLine: req.BizLine.String(), CommandID: req.CommandID, UserID: req.UserID, Kind: "lease_renewed", State: current.State, Message: "Worker 已续租", DataJSON: "{}"})
	if err != nil {
		return dto.CommandView{}, err
	}
	if !updated {
		return dto.CommandView{}, errors.New("命令租约已失效或不属于当前 Worker")
	}
	return s.GetCommand(ctx, req.BizLine, req.UserID, req.CommandID)
}

func (s *service) ReportCommandActivity(ctx context.Context, req dto.ReportCommandActivityRequest) (dto.CommandView, error) {
	if err := validateLeasedCommand(req.BizLine, req.UserID, req.WorkerID, req.CommandID, req.LeaseToken); err != nil {
		return dto.CommandView{}, err
	}
	message := strings.TrimSpace(req.Message)
	if message == "" {
		return dto.CommandView{}, errors.New("活动说明不能为空")
	}
	if utf8.RuneCountInString(message) > 1024 {
		return dto.CommandView{}, errors.New("活动说明不能超过 1024 字符")
	}
	data, err := normalizeCommandJSONObject(req.Data, maxCommandEventBytes, "活动数据")
	if err != nil {
		return dto.CommandView{}, err
	}
	now := time.Now()
	expiresAt := now.Add(commandLeaseDuration)
	commandValues := map[string]any{"state": CommandStateRunning, "lease_expires_at": expiresAt, "started_at": gorm.Expr("COALESCE(started_at, ?)", now)}
	if req.Progress != nil {
		if *req.Progress < 0 || *req.Progress > 100 {
			return dto.CommandView{}, errors.New("命令进度必须在 0 到 100 之间")
		}
		commandValues["progress"] = *req.Progress
	}
	eventData := withCommandProgress(data, req.Progress)
	updated, err := s.repo.UpdateActiveCommand(ctx, req.BizLine.String(), req.UserID, req.CommandID, req.WorkerID, req.LeaseToken,
		commandValues,
		&repository.DeliveryCommandEvent{BizLine: req.BizLine.String(), CommandID: req.CommandID, UserID: req.UserID, Kind: "activity", State: CommandStateRunning, Message: message, DataJSON: eventData})
	if err != nil {
		return dto.CommandView{}, err
	}
	if !updated {
		return dto.CommandView{}, errors.New("命令租约已失效或不属于当前 Worker")
	}
	return s.GetCommand(ctx, req.BizLine, req.UserID, req.CommandID)
}

func (s *service) CompleteCommand(ctx context.Context, req dto.CompleteCommandRequest) (dto.CommandView, error) {
	if err := validateLeasedCommand(req.BizLine, req.UserID, req.WorkerID, req.CommandID, req.LeaseToken); err != nil {
		return dto.CommandView{}, err
	}
	state := strings.ToLower(strings.TrimSpace(req.State))
	if state != CommandStateSucceeded && state != CommandStateFailed && state != CommandStateCancelled {
		return dto.CommandView{}, errors.New("命令完成状态只能是 succeeded、failed 或 cancelled")
	}
	result, err := normalizeCommandJSONObject(req.Result, maxCommandResultBytes, "命令结果")
	if err != nil {
		return dto.CommandView{}, err
	}
	message := strings.TrimSpace(req.ErrorMessage)
	if utf8.RuneCountInString(message) > 1024 {
		return dto.CommandView{}, errors.New("错误说明不能超过 1024 字符")
	}
	now := time.Now()
	completionValues := map[string]any{"state": state, "result_json": result, "error_message": message, "finished_at": now, "lease_expires_at": nil}
	if state == CommandStateSucceeded {
		completionValues["progress"] = 100
	}
	updated, err := s.repo.UpdateActiveCommand(ctx, req.BizLine.String(), req.UserID, req.CommandID, req.WorkerID, req.LeaseToken,
		completionValues,
		&repository.DeliveryCommandEvent{BizLine: req.BizLine.String(), CommandID: req.CommandID, UserID: req.UserID, Kind: "completed", State: state, Message: completionMessage(state, message), DataJSON: result})
	if err != nil {
		return dto.CommandView{}, err
	}
	if !updated {
		return dto.CommandView{}, errors.New("命令租约已失效或不属于当前 Worker")
	}
	return s.GetCommand(ctx, req.BizLine, req.UserID, req.CommandID)
}

func (s *service) ListCommandEvents(ctx context.Context, query dto.CommandEventQuery) ([]dto.CommandEventView, error) {
	if !query.BizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if strings.TrimSpace(query.UserID) == "" || strings.TrimSpace(query.CommandID) == "" {
		return nil, errors.New("缺少用户或命令标识")
	}
	if _, err := s.repo.FindCommand(ctx, query.BizLine.String(), query.UserID, query.CommandID); err != nil {
		return nil, translate(err)
	}
	limit := query.Limit
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	rows, err := s.repo.ListCommandEvents(ctx, query.BizLine.String(), query.UserID, query.CommandID, query.AfterID, limit)
	if err != nil {
		return nil, err
	}
	views := make([]dto.CommandEventView, 0, len(rows))
	for _, row := range rows {
		views = append(views, dto.CommandEventView{ID: row.Id, Kind: row.Kind, State: row.State, Message: row.Message, Data: rawJSONObject(row.DataJSON), CreatedAt: row.CreatedAt})
	}
	return views, nil
}

func (s *service) ReconcileExpiredCommands(ctx context.Context) ([]dto.CommandView, error) {
	rows, err := s.repo.ListExpiredCommands(ctx, time.Now(), 100)
	if err != nil {
		return nil, err
	}
	views := make([]dto.CommandView, 0, len(rows))
	for _, row := range rows {
		recovered, changed, err := s.repo.RecoverExpiredCommand(ctx, row.BizLine, row.CommandID, time.Now(), maxCommandAttempts)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !changed || recovered == nil {
			continue
		}
		if recovered.State == CommandStatePending {
			s.notifyPendingCommand(ctx, recovered.UserID, recovered.CommandID)
		}
		views = append(views, toCommandView(recovered))
	}
	unclaimed, err := s.repo.ListUnclaimedCommands(ctx, time.Now().Add(-commandLeaseDuration), 100)
	if err != nil {
		return nil, err
	}
	for _, row := range unclaimed {
		recovered, changed, err := s.repo.RecoverUnclaimedCommand(ctx, row.BizLine, row.CommandID, time.Now().Add(-commandLeaseDuration), maxCommandDispatches)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !changed || recovered == nil {
			continue
		}
		if recovered.State == CommandStatePending {
			s.notifyPendingCommand(ctx, recovered.UserID, recovered.CommandID)
		}
		views = append(views, toCommandView(recovered))
	}
	return views, nil
}

// PurgeFinishedCommands 分两档清理：快照命令留一小时，其余命令留一个月。每轮各取
// 一批，调用方按固定节奏反复调用即可，不需要一次把历史清完。
// staleReadOnlyCommand 挡住已经没人要的界面快照：手机端等 90 秒就放弃，界面回来
// 后会重新问一次。Worker 掉线几分钟再上来时，让这些旧请求上机跑只会把新请求排在
// 后面，还会给用户回一份两分钟前的界面。
func staleReadOnlyCommand(commandType string, createdAt, now time.Time) bool {
	return IsReadOnlyCommand(commandType) && now.Sub(createdAt) > readOnlyCommandStaleWindow
}

// commandWorkerOnline 与派发时判定「这个项目有没有插件在听」用的是同一个窗口：
// 界面上说在线、实际却领不走命令，比直接说离线更难排查。
func commandWorkerOnline(lastHeartbeatAt, now time.Time) bool {
	return !lastHeartbeatAt.IsZero() && now.Sub(lastHeartbeatAt) <= commandWorkerOnlineWindow
}

func (s *service) PurgeFinishedCommands(ctx context.Context) (int64, error) {
	now := time.Now()
	readOnly, err := s.repo.DeleteFinishedCommands(ctx, now.Add(-readOnlyCommandRetention), readOnlyCommandTypeList(), true, commandPurgeBatch)
	if err != nil {
		return 0, err
	}
	rest, err := s.repo.DeleteFinishedCommands(ctx, now.Add(-commandRetention), readOnlyCommandTypeList(), false, commandPurgeBatch)
	if err != nil {
		return readOnly, err
	}
	return readOnly + rest, nil
}

func (s *service) GetCommandWorkerStatus(ctx context.Context, bizLine contract.BizLine, userID string, programID int64) (dto.CommandWorkerStatusView, error) {
	if !bizLine.Valid() {
		return dto.CommandWorkerStatusView{}, contract.ErrBizLineRequired
	}
	if strings.TrimSpace(userID) == "" {
		return dto.CommandWorkerStatusView{}, errors.New("缺少用户标识")
	}
	view := dto.CommandWorkerStatusView{OnlineWindowSeconds: int(commandWorkerOnlineWindow / time.Second)}
	row, err := s.repo.FindLatestCommandWorker(ctx, bizLine.String(), userID, programID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		// 从没登记过插件也是一种明确答案：界面要说「未登记执行电脑」，不是报错。
		return view, nil
	}
	if err != nil {
		return dto.CommandWorkerStatusView{}, err
	}
	heartbeat := row.LastHeartbeatAt
	view.WorkerID = row.WorkerID
	view.DisplayName = row.DisplayName
	view.LastHeartbeatAt = &heartbeat
	view.Online = commandWorkerOnline(heartbeat, time.Now())
	return view, nil
}

func (s *service) notifyPendingCommand(ctx context.Context, userID, commandID string) {
	if s.commandNotifier != nil {
		_ = s.commandNotifier.NotifyPendingCommand(ctx, userID, commandID)
	}
}

func toCommandView(row *repository.DeliveryCommand) dto.CommandView {
	return dto.CommandView{CommandID: row.CommandID, BizLine: row.BizLine, ProgramID: row.ProgramID, UserID: row.UserID, CommandType: row.CommandType,
		Input: rawJSONObject(row.InputJSON), Result: rawJSONObject(row.ResultJSON), ErrorMessage: row.ErrorMessage, State: row.State, Progress: row.Progress, CancelRequested: row.CancelRequested,
		LeaseWorkerID: row.LeaseWorkerID, LeaseExpiresAt: row.LeaseExpiresAt, DispatchCount: row.DispatchCount, AttemptCount: row.AttemptCount, StartedAt: row.StartedAt, FinishedAt: row.FinishedAt,
		CreatedAt: row.CreatedTime, UpdatedAt: row.UpdatedTime}
}

func toCommandAttachmentView(row *repository.DeliveryCommandAttachment) dto.CommandAttachmentView {
	return dto.CommandAttachmentView{
		AttachmentID: row.AttachmentID, ProgramID: row.ProgramID, ItemKey: row.ItemKey, Name: row.Name,
		ContentType: row.ContentType, Size: row.Size, CreatedAt: row.CreatedTime,
	}
}

func safeCommandAttachmentName(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\\x00", ""))
	value = strings.ReplaceAll(value, "\\", "/")
	if index := strings.LastIndex(value, "/"); index >= 0 {
		value = value[index+1:]
	}
	if value == "" {
		return "attachment"
	}
	runes := []rune(value)
	if len(runes) > 160 {
		return string(runes[:160])
	}
	return value
}

func generateCommandAttachmentID() string { return "attachment-" + randomHex(16) }

func normalizeCommandType(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if !commandTypePattern.MatchString(value) {
		return "", errors.New("命令类型只能包含小写字母、数字、点、下划线或连字符，且不能超过 64 字符")
	}
	return value, nil
}

func normalizeIdempotencyKey(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || utf8.RuneCountInString(value) > 128 {
		return "", errors.New("幂等键不能为空且不能超过 128 字符")
	}
	return value, nil
}

func normalizeWorkerID(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !executorTypePattern.MatchString(value) {
		return "", errors.New("Worker 标识只能包含小写字母、数字、下划线或连字符，且不能超过 32 字符")
	}
	return value, nil
}

func normalizeProgramIDs(values []int64) ([]int64, error) {
	seen := make(map[int64]struct{}, len(values))
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if value <= 0 {
			return nil, errors.New("工作目录映射缺少项目标识")
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	if len(result) == 0 {
		return nil, errors.New("请至少登记一个本机项目工作目录映射")
	}
	return result, nil
}

func normalizeCapabilities(values []string) ([]string, error) {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			continue
		}
		normalized, err := normalizeCommandType(value)
		if err != nil {
			return nil, err
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	if len(result) == 0 {
		return nil, errors.New("请至少登记一个 Worker 支持的命令类型")
	}
	return result, nil
}

func storedCommandCapabilities(value string) []string {
	var capabilities []string
	if json.Unmarshal([]byte(value), &capabilities) != nil {
		return nil
	}
	return capabilities
}

// narrowCommandCapabilities 把领取通道申请的类型收敛到该 Worker 已登记的能力内，
// 请求里出现未登记的类型时直接忽略，不会扩权。
func narrowCommandCapabilities(capabilities, requested []string) []string {
	if len(requested) == 0 {
		return capabilities
	}
	allowed := make(map[string]struct{}, len(capabilities))
	for _, capability := range capabilities {
		allowed[capability] = struct{}{}
	}
	narrowed := make([]string, 0, len(requested))
	for _, value := range requested {
		commandType, err := normalizeCommandType(value)
		if err != nil {
			continue
		}
		if _, ok := allowed[commandType]; ok {
			narrowed = append(narrowed, commandType)
		}
	}
	return narrowed
}

func normalizeCommandJSONObject(raw json.RawMessage, maxBytes int, label string) (string, error) {
	if len(raw) == 0 {
		return "{}", nil
	}
	if len(raw) > maxBytes {
		return "", fmt.Errorf("%s不能超过 %dKB", label, maxBytes/1024)
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return "", fmt.Errorf("%s必须是 JSON 对象", label)
	}
	if containsAbsoluteLocalPath(value) {
		return "", fmt.Errorf("%s不能包含本机绝对路径，请使用项目内相对路径", label)
	}
	normalized, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("%s不是有效 JSON", label)
	}
	return string(normalized), nil
}

func containsAbsoluteLocalPath(value any) bool {
	switch current := value.(type) {
	case map[string]any:
		for _, nested := range current {
			if containsAbsoluteLocalPath(nested) {
				return true
			}
		}
	case []any:
		for _, nested := range current {
			if containsAbsoluteLocalPath(nested) {
				return true
			}
		}
	case string:
		value := strings.TrimSpace(current)
		if strings.HasPrefix(value, "/") || strings.HasPrefix(value, `\\`) {
			return true
		}
		if len(value) >= 3 && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) && value[1] == ':' && (value[2] == '/' || value[2] == '\\') {
			return true
		}
	}
	return false
}

func rawJSONObject(value string) json.RawMessage {
	if strings.TrimSpace(value) == "" {
		return json.RawMessage("{}")
	}
	return json.RawMessage(value)
}

func withCommandProgress(data string, progress *int) string {
	if progress == nil {
		return data
	}
	value := map[string]any{}
	if json.Unmarshal([]byte(data), &value) != nil {
		return data
	}
	value["progress"] = *progress
	encoded, err := json.Marshal(value)
	if err != nil {
		return data
	}
	return string(encoded)
}

func generateCommandID() string  { return "cmd-" + randomHex(12) }
func generateLeaseToken() string { return randomHex(24) }

func randomHex(size int) string {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw)
}

func validateLeasedCommand(bizLine contract.BizLine, userID, workerID, commandID, leaseToken string) error {
	if !bizLine.Valid() {
		return contract.ErrBizLineRequired
	}
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(commandID) == "" || strings.TrimSpace(leaseToken) == "" {
		return errors.New("缺少用户、命令或租约标识")
	}
	_, err := normalizeWorkerID(workerID)
	return err
}

func completionMessage(state, errorMessage string) string {
	if strings.TrimSpace(errorMessage) != "" {
		return errorMessage
	}
	switch state {
	case CommandStateSucceeded:
		return "Worker 已完成命令"
	case CommandStateCancelled:
		return "Worker 已取消命令"
	default:
		return "Worker 执行命令失败"
	}
}
