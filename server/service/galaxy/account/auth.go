package account

import (
	"context"
	"errors"
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"

	"service/galaxy"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

var (
	// ErrLoginFailed 用户名不存在、密码错、账号停用都是这一句：分开说等于告诉试探者这个用户名存在。
	ErrLoginFailed = errors.New("账号或密码错误")
	// ErrNotLogin 令牌无效、过期、账号停用或改过密码。接口层把它翻成客户端认得的 not login。
	ErrNotLogin       = errors.New("登录凭证已失效，请重新登录")
	ErrUsernameTaken  = errors.New("这个用户名已经被注册")
	ErrWrongPassword  = errors.New("当前密码不正确")
	ErrSamePassword   = errors.New("新密码不能和当前密码相同")
	ErrAccountMissing = errors.New("账号不存在")
	// ErrInviteInvalid 邀请码对不上。不悄悄忽略：注册成了、返现却没挂上，邀请人要到很久以后才发现。
	ErrInviteInvalid = errors.New("邀请码无效：检查一下分享链接，或者清空邀请码直接注册")
)

// usernamePattern 登录名：字母数字开头，允许 _ . @ + -，所以手机号和邮箱都能直接当用户名用。
// 统一存小写，Fly 和 fly 是同一个人。
var usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.@+-]*$`)

func normalizeUsername(raw string) (string, error) {
	username := strings.ToLower(strings.TrimSpace(raw))
	if username == "" {
		return "", errors.New("请输入用户名")
	}
	if len(username) < 2 || len(username) > 64 {
		return "", errors.New("用户名长度需要在 2 到 64 个字符之间")
	}
	if !usernamePattern.MatchString(username) {
		return "", errors.New("用户名只能用字母、数字和 _ . @ + -，且以字母或数字开头")
	}
	return username, nil
}

// hashPassword 与 service/identity、service/manager 同一套 bcrypt，但各写一份：
// 这几套账号体系是刻意分开的，共用一个工具函数会让人以为它们还有别的牵连。
func hashPassword(value string) (string, error) {
	if len(value) < 8 {
		return "", errors.New("密码至少需要 8 个字符")
	}
	// bcrypt 只看前 72 个字节，再长的部分改了也登得进去 —— 与其悄悄截断，不如当场说清楚。
	if len(value) > 72 {
		return "", errors.New("密码不能超过 72 个字节")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(value), bcrypt.DefaultCost)
	return string(hash), err
}

func (s *service) Register(ctx context.Context, req dto.RegisterAccountRequest) (dto.AccountLoginResult, error) {
	if !validSide(req.Side) {
		return dto.AccountLoginResult{}, fmt.Errorf("未知的账号端: %s", req.Side)
	}
	if s.tokenSecret == "" {
		// 先挡在建账号之前：建出来却签不出令牌，用户会看到「注册失败」，
		// 再点一次又撞上「用户名已被注册」。
		return dto.AccountLoginResult{}, errTokenSecretMissing
	}
	username, err := normalizeUsername(req.Username)
	if err != nil {
		return dto.AccountLoginResult{}, err
	}
	displayName := strings.TrimSpace(req.DisplayName)
	if displayName == "" {
		displayName = username
	}
	if utf8.RuneCountInString(displayName) > 64 {
		return dto.AccountLoginResult{}, errors.New("昵称不能超过 64 个字")
	}
	if _, err := s.repository.FindUserByName(ctx, bizLine, req.Side, username); err == nil {
		return dto.AccountLoginResult{}, ErrUsernameTaken
	} else if !repository.IsNotFound(err) {
		return dto.AccountLoginResult{}, err
	}
	// 邀请码两端都认，但**各查各的表**：两端是两批人，邀请码的命名空间不共享。
	// 共用一张表的话，一个共享端的码填进使用端的注册页会「查得到但返错人」。
	// 在建账号之前查：码不对就当场说，别等用户名已经占上了才报错。
	invitedBy := ""
	if code := galaxy.NormalizeInviteCode(req.InviteCode); code != "" {
		resolved, err := s.resolveInviter(ctx, req.Side, code)
		if err != nil {
			return dto.AccountLoginResult{}, err
		}
		invitedBy = resolved
	}
	hash, err := hashPassword(req.Password)
	if err != nil {
		return dto.AccountLoginResult{}, err
	}
	now := time.Now()
	row := &repository.GalaxyUser{
		BizLine: bizLine, UserID: idPrefix(req.Side) + galaxy.NewULID(now), Side: req.Side,
		Username: username, DisplayName: displayName, PasswordHash: hash,
		Status: dto.AccountActive, TokenVersion: 1, LastLoginAt: &now,
	}
	// 账号和它的邀请关系一起建：账号建成了、邀请关系没写进去，这个人之后
	// 买的每一单（使用端）或跑出来的每一笔积分（共享端）都不会给邀请人返现，
	// 而且没有任何地方会报错。
	err = s.repository.Tx(ctx, func(tx *repository.GalaxyRepository) error {
		if err := tx.CreateUser(ctx, row); err != nil {
			return err
		}
		switch row.Side {
		case dto.SideConsumer:
			_, err := galaxy.CreateReferral(ctx, tx, row.UserID, invitedBy)
			return err
		case dto.SideProvider:
			_, err := galaxy.CreateProviderReferral(ctx, tx, row.UserID, invitedBy)
			return err
		}
		return nil
	})
	if err != nil {
		// 两个人同时抢一个用户名：查重都过了，唯一索引挡下后一个。
		// 回头再查一次，把 1062 翻成人话，而不是把驱动的报错原样丢给用户。
		if _, findErr := s.repository.FindUserByName(ctx, bizLine, req.Side, username); findErr == nil {
			return dto.AccountLoginResult{}, ErrUsernameTaken
		}
		return dto.AccountLoginResult{}, err
	}
	result, err := s.loginResult(ctx, row)
	if err != nil {
		return dto.AccountLoginResult{}, err
	}
	result.Key = s.issueRegistrationKey(ctx, row)
	return result, nil
}

// issueRegistrationKey 使用端新账号默认送一把密钥，明文跟着注册响应回去一次。
//
// 在账号那个事务之外：签密钥是另一个领域的事，把它塞进建账号的事务里，等于让
// 「密钥表写不进去」能回滚掉一个已经注册成功的人。
//
// 也正因为在事务外，签不出来不算注册失败 —— 账号已经建出来了，这时候报错，
// 用户重来一遍只会撞上「用户名已被注册」，反倒进不去了。没签出来在密钥页上
// 看得见（一把都没有），点一下「新建」就补上，所以这里只记一行日志。
//
// 共享端不送：那边出算力，用的是接入密钥，不是这种花钱的算力密钥。
func (s *service) issueRegistrationKey(ctx context.Context, row *repository.GalaxyUser) *dto.IssuedKeyView {
	if s.keys == nil || row.Side != dto.SideConsumer {
		return nil
	}
	view, err := s.keys.IssueRegistrationKey(ctx, row.UserID)
	if err != nil {
		log.Printf("galaxy: 新账号 %s 的默认密钥没签出来，注册照常算成: %v", row.UserID, err)
		return nil
	}
	return &view
}

// resolveInviter 按端查邀请码的主人，返回他的账号 id。
//
// 两端各查各的表是刻意的：邀请码的命名空间不共享，共享端的码在使用端**查不到**，
// 于是会明明白白地报「邀请码无效」，而不是悄悄把返现记到另一端的某个人头上。
func (s *service) resolveInviter(ctx context.Context, side, code string) (string, error) {
	switch side {
	case dto.SideConsumer:
		row, err := s.repository.FindReferralByCode(ctx, bizLine, code)
		if repository.IsNotFound(err) {
			return "", ErrInviteInvalid
		}
		if err != nil {
			return "", err
		}
		return row.UserID, nil
	case dto.SideProvider:
		row, err := s.repository.FindProviderReferralByCode(ctx, bizLine, code)
		if repository.IsNotFound(err) {
			return "", ErrInviteInvalid
		}
		if err != nil {
			return "", err
		}
		return row.UserID, nil
	}
	return "", nil
}

func (s *service) Login(ctx context.Context, req dto.LoginAccountRequest) (dto.AccountLoginResult, error) {
	if !validSide(req.Side) {
		return dto.AccountLoginResult{}, fmt.Errorf("未知的账号端: %s", req.Side)
	}
	username := strings.ToLower(strings.TrimSpace(req.Username))
	if username == "" || req.Password == "" {
		return dto.AccountLoginResult{}, errors.New("请输入用户名和密码")
	}
	row, err := s.repository.FindUserByName(ctx, bizLine, req.Side, username)
	if repository.IsNotFound(err) {
		return dto.AccountLoginResult{}, ErrLoginFailed
	}
	if err != nil {
		return dto.AccountLoginResult{}, fmt.Errorf("认证服务不可用: %w", err)
	}
	if row.Status != dto.AccountActive || bcrypt.CompareHashAndPassword([]byte(row.PasswordHash), []byte(req.Password)) != nil {
		return dto.AccountLoginResult{}, ErrLoginFailed
	}
	now := time.Now()
	// 登录时间写不进去不该挡住登录本身。
	if err := s.repository.TouchUserLogin(ctx, bizLine, row.Side, row.UserID, now); err == nil {
		row.LastLoginAt = &now
	}
	return s.loginResult(ctx, row)
}

// Authenticate 凭证本身的问题一律归成 ErrNotLogin，客户端据此清令牌回登录页；
// 查库失败这种基础设施问题原样返回 —— 数据库抖一下不该把所有人踢下线。
func (s *service) Authenticate(ctx context.Context, side, token string) (Principal, error) {
	claims, err := parseToken(s.tokenSecret, side, token, time.Now())
	if errors.Is(err, errTokenSecretMissing) {
		return Principal{}, err
	}
	if err != nil {
		return Principal{}, ErrNotLogin
	}
	// 只在这一端的表里找。令牌里签的端就是这么被兑现的：一张共享端的令牌拿到
	// 使用端的接口上，即便签名对、版本对，那个 pu_ 开头的 id 在使用端表里也不存在。
	row, err := s.repository.FindUser(ctx, bizLine, side, claims.Subject)
	if err != nil {
		if repository.IsNotFound(err) {
			return Principal{}, ErrNotLogin
		}
		return Principal{}, err
	}
	if row.Status != dto.AccountActive || row.TokenVersion != claims.Version {
		return Principal{}, ErrNotLogin
	}
	return Principal{
		UserID: row.UserID, Side: row.Side, Username: row.Username,
		DisplayName: row.DisplayName, MustChangePassword: row.MustChangePassword,
	}, nil
}

func (s *service) Current(ctx context.Context, side, userID string) (dto.AccountView, error) {
	row, err := s.repository.FindUser(ctx, bizLine, side, userID)
	if repository.IsNotFound(err) {
		return dto.AccountView{}, ErrAccountMissing
	}
	if err != nil {
		return dto.AccountView{}, err
	}
	views, err := s.views(ctx, []*repository.GalaxyUser{row})
	if err != nil {
		return dto.AccountView{}, err
	}
	return views[0], nil
}

func (s *service) ChangeOwnPassword(ctx context.Context, side, userID string, req dto.ChangeAccountPasswordRequest) (dto.AccountLoginResult, error) {
	if req.CurrentPassword == "" || req.NewPassword == "" {
		return dto.AccountLoginResult{}, errors.New("请填写当前密码和新密码")
	}
	row, err := s.repository.FindUser(ctx, bizLine, side, userID)
	if repository.IsNotFound(err) {
		return dto.AccountLoginResult{}, ErrAccountMissing
	}
	if err != nil {
		return dto.AccountLoginResult{}, err
	}
	if bcrypt.CompareHashAndPassword([]byte(row.PasswordHash), []byte(req.CurrentPassword)) != nil {
		return dto.AccountLoginResult{}, ErrWrongPassword
	}
	if req.CurrentPassword == req.NewPassword {
		return dto.AccountLoginResult{}, ErrSamePassword
	}
	hash, err := hashPassword(req.NewPassword)
	if err != nil {
		return dto.AccountLoginResult{}, err
	}
	// 改密即全端下线：密码被人拿去登过的那台机器上的令牌也跟着失效。
	// 当前这台接着用回去的新令牌，不用重新登录。
	if err := s.repository.BumpTokenVersion(ctx, bizLine, side, userID, map[string]any{
		"password_hash": hash, "must_change_password": false,
	}); err != nil {
		return dto.AccountLoginResult{}, err
	}
	updated, err := s.repository.FindUser(ctx, bizLine, side, userID)
	if err != nil {
		return dto.AccountLoginResult{}, err
	}
	return s.loginResult(ctx, updated)
}

func (s *service) loginResult(ctx context.Context, row *repository.GalaxyUser) (dto.AccountLoginResult, error) {
	token, err := issueToken(s.tokenSecret, row.Side, row.UserID, row.TokenVersion, time.Now().Add(s.tokenTTL))
	if err != nil {
		return dto.AccountLoginResult{}, err
	}
	views, err := s.views(ctx, []*repository.GalaxyUser{row})
	if err != nil {
		return dto.AccountLoginResult{}, err
	}
	return dto.AccountLoginResult{Token: token, User: views[0]}, nil
}

// views 转成对外形状，共享端顺带补上散户 / 工作室。批量查一次，列表不用每行一次。
func (s *service) views(ctx context.Context, rows []*repository.GalaxyUser) ([]dto.AccountView, error) {
	providers := make([]string, 0, len(rows))
	for _, row := range rows {
		if row.Side == dto.SideProvider {
			providers = append(providers, row.UserID)
		}
	}
	studios := map[string]bool{}
	if len(providers) > 0 {
		marks, err := s.repository.ListProviders(ctx, bizLine, providers)
		if err != nil {
			return nil, err
		}
		for _, mark := range marks {
			studios[mark.OwnerUserID] = mark.ProviderType == dto.ProviderStudio
		}
	}
	views := make([]dto.AccountView, 0, len(rows))
	for _, row := range rows {
		view := dto.AccountView{
			ID: row.UserID, Side: row.Side, Username: row.Username, DisplayName: row.DisplayName,
			Status: row.Status, MustChangePassword: row.MustChangePassword,
			LastLoginAt: row.LastLoginAt, CreatedAt: row.CreatedTime,
		}
		if row.Side == dto.SideProvider {
			view.ProviderType = dto.ProviderIndividual
			if studios[row.UserID] {
				view.ProviderType = dto.ProviderStudio
			}
		}
		views = append(views, view)
	}
	return views, nil
}
