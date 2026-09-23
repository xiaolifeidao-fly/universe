package manager

import "errors"

// 哨兵错误。这些文案会经 httpx.JSON 直接显示给用户，写成人能看懂的中文短句。
var (
	ErrTokenStoreMissing = errors.New("令牌存储未配置")
	// ErrNotLogin 令牌缺失、过期或已被吊销。三种情况共用一句话：
	// 分开说等于告诉试探者「这个令牌以前是有效的」。
	//
	// 文案里的「登录凭证」四个字是**契约**：前端 createHttpClient 就是按
	// "not login" / "登录凭证" 这两个子串判断要不要清 token 跳登录页的。
	// 换掉它，会话过期就只会弹一个红条，用户卡在一个点什么都失败的页面上。
	ErrNotLogin = errors.New("登录凭证已失效，请重新登录")
	// ErrLoginFailed 用户名不存在、密码错、账号被禁用共用一句话，防账号枚举。
	ErrLoginFailed = errors.New("用户名或密码不正确")
	// ErrLoginLocked 连续失败太多次，闸门还没到期。
	//
	// 和 ErrLoginFailed 分开说是刻意的：合成一句的话，被锁住的人会一直以为是
	// 自己记错了密码，而这时候每一次尝试都不会走到 bcrypt，也就永远不会成功。
	//
	// 它不泄露「这个用户名存在」：计数按**输进来的用户名**记，账号在不在都一样
	// 记、一样锁。调用方用 %w 包一句「还要等多久」再返回。
	ErrLoginLocked       = errors.New("连续登录失败次数过多")
	ErrNoPermission      = errors.New("没有访问该功能的权限")
	ErrReadOnlyRole      = errors.New("当前角色没有写入权限")
	ErrMustChangePasswd  = errors.New("请先修改初始密码")
	ErrNotFound          = errors.New("记录不存在")
	ErrUsernameTaken     = errors.New("用户名已被占用")
	ErrRoleCodeTaken     = errors.New("角色编码已被占用")
	ErrResourceCodeTaken = errors.New("资源编码已被占用")
	ErrLastSuperAdmin    = errors.New("不能移除最后一个超级管理员")
	ErrWeakPassword      = errors.New("密码至少需要 8 个字符")
	ErrSamePassword      = errors.New("新密码不能和当前密码相同")
)
