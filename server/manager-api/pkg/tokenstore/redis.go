// Package tokenstore 是管理端登录令牌的 Redis 实现。
//
// 领域层只认 manager.TokenStore 这个接口，不认识 Redis。用外部存储而不是无状态
// 签名令牌，图的是**即时吊销**：管理端会动真钱，撤权、禁用、改密必须当场生效。
package tokenstore

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"service/manager"
)

type Options struct {
	// Addresses 逗号分隔。留空表示没配 Redis，New 返回 nil，装配层据此拒绝启动。
	Addresses string
	Password  string
	Mode      string
	DB        int
	Namespace string
}

const defaultNamespace = "manager"

type Store struct {
	client    redis.UniversalClient
	namespace string
}

func New(options Options) *Store {
	values := make([]string, 0, 2)
	for _, value := range strings.Split(options.Addresses, ",") {
		if value = strings.TrimSpace(value); value != "" {
			values = append(values, value)
		}
	}
	if len(values) == 0 {
		return nil
	}
	namespace := strings.TrimSpace(options.Namespace)
	if namespace == "" {
		namespace = defaultNamespace
	}
	var client redis.UniversalClient
	if strings.EqualFold(strings.TrimSpace(options.Mode), "cluster") {
		client = redis.NewClusterClient(&redis.ClusterOptions{Addrs: values, Password: options.Password})
	} else {
		client = redis.NewUniversalClient(&redis.UniversalOptions{
			Addrs: values, Password: options.Password, DB: options.DB,
		})
	}
	return &Store{client: client, namespace: namespace}
}

func (s *Store) Close() error {
	if s == nil || s.client == nil {
		return nil
	}
	return s.client.Close()
}

// Ping 装配阶段探一次。Redis 是管理端的启动硬依赖 —— 起不来就不该假装能服务，
// 让它在启动时失败，好过每个登录请求各失败一次。
func (s *Store) Ping(ctx context.Context) error {
	return s.client.Ping(ctx).Err()
}

func (s *Store) tokenKey(token string) string { return s.namespace + ":token:" + token }

// userKey 是反向索引：一个人名下所有活着的令牌。
// 没有它就只能等令牌自然过期，撤权做不到当场生效。
func (s *Store) userKey(userID string) string { return s.namespace + ":user:" + userID + ":tokens" }

func (s *Store) versionKey() string { return s.namespace + ":acl:version" }

func (s *Store) Save(ctx context.Context, token string, session manager.Session, ttl time.Duration) error {
	payload, err := json.Marshal(session)
	if err != nil {
		return err
	}
	pipe := s.client.TxPipeline()
	pipe.Set(ctx, s.tokenKey(token), payload, ttl)
	pipe.SAdd(ctx, s.userKey(session.UserID), token)
	// 反向索引的过期时间比会话长一截：它只是个索引，早于令牌过期会让
	// DeleteByUser 漏掉还活着的会话，那正是「撤权没生效」。
	pipe.Expire(ctx, s.userKey(session.UserID), ttl+time.Hour)
	_, err = pipe.Exec(ctx)
	return err
}

// Load 返回 (会话, 是否存在, 错误)。
// 键不存在返回 (零值, false, nil)；连不上 Redis 返回错误 —— 两者不能混，
// 后者被当成「令牌无效」的话，Redis 一抖所有人被登出，看起来像令牌集体失效。
func (s *Store) Load(ctx context.Context, token string) (manager.Session, bool, error) {
	raw, err := s.client.Get(ctx, s.tokenKey(token)).Bytes()
	if errors.Is(err, redis.Nil) {
		return manager.Session{}, false, nil
	}
	if err != nil {
		return manager.Session{}, false, err
	}
	var session manager.Session
	if err := json.Unmarshal(raw, &session); err != nil {
		// 存进去的是我们自己序列化的 JSON，解不出来说明这个键被别的东西占了。
		// 当作无效令牌，不当作故障。
		return manager.Session{}, false, nil
	}
	return session, true, nil
}

func (s *Store) Touch(ctx context.Context, token string, ttl time.Duration) error {
	return s.client.Expire(ctx, s.tokenKey(token), ttl).Err()
}

func (s *Store) Delete(ctx context.Context, token string) error {
	// 先读出会话才知道该从谁的索引里摘掉这个令牌。读不到就只删令牌本身，
	// 索引里留个死键不影响正确性（DeleteByUser 会跳过读不出的令牌）。
	session, ok, err := s.Load(ctx, token)
	if err != nil {
		return err
	}
	pipe := s.client.TxPipeline()
	pipe.Del(ctx, s.tokenKey(token))
	if ok {
		pipe.SRem(ctx, s.userKey(session.UserID), token)
	}
	_, err = pipe.Exec(ctx)
	return err
}

// DeleteByUser 踢掉一个人的全部会话。撤权、禁用、改密都走它。
func (s *Store) DeleteByUser(ctx context.Context, userID string) (int, error) {
	tokens, err := s.client.SMembers(ctx, s.userKey(userID)).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return 0, err
	}
	if len(tokens) == 0 {
		return 0, nil
	}
	keys := make([]string, 0, len(tokens))
	for _, token := range tokens {
		keys = append(keys, s.tokenKey(token))
	}
	pipe := s.client.TxPipeline()
	pipe.Del(ctx, keys...)
	pipe.Del(ctx, s.userKey(userID))
	if _, err := pipe.Exec(ctx); err != nil {
		return 0, err
	}
	return len(tokens), nil
}

// ACLVersion 权限表版本号。多实例部署时，别的实例改了权限，这边靠它发现要重建缓存。
func (s *Store) ACLVersion(ctx context.Context) (int64, error) {
	value, err := s.client.Get(ctx, s.versionKey()).Int64()
	if errors.Is(err, redis.Nil) {
		return 0, nil
	}
	return value, err
}

func (s *Store) BumpACLVersion(ctx context.Context) error {
	return s.client.Incr(ctx, s.versionKey()).Err()
}

var _ manager.TokenStore = (*Store)(nil)
