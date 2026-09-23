// Package redisqueue implements the non-authoritative notification side of the
// command protocol. Every command is still re-read and leased from MySQL.
package redisqueue

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	queuePrefix = "delivery:command:notify:"
	queueTTL    = 10 * time.Minute
	queueLimit  = 1000
)

type Queue struct {
	client redis.UniversalClient
}

func New(addresses, password, mode string) *Queue {
	values := make([]string, 0, 2)
	for _, value := range strings.Split(addresses, ",") {
		if value = strings.TrimSpace(value); value != "" {
			values = append(values, value)
		}
	}
	if len(values) == 0 {
		return nil
	}
	if strings.EqualFold(strings.TrimSpace(mode), "cluster") {
		return &Queue{client: redis.NewClusterClient(&redis.ClusterOptions{Addrs: values, Password: password})}
	}
	return &Queue{client: redis.NewUniversalClient(&redis.UniversalOptions{Addrs: values, Password: password})}
}

func (q *Queue) Close() error {
	if q == nil || q.client == nil {
		return nil
	}
	return q.client.Close()
}

// NotifyPendingCommand stores only an opaque command id. The worker always asks
// delivery for a fresh database-backed lease before it receives the input body.
func (q *Queue) NotifyPendingCommand(ctx context.Context, userID, commandID string) error {
	if q == nil || q.client == nil {
		return nil
	}
	pipe := q.client.TxPipeline()
	pipe.LPush(ctx, key(userID), commandID)
	pipe.LTrim(ctx, key(userID), 0, queueLimit-1)
	pipe.Expire(ctx, key(userID), queueTTL)
	_, err := pipe.Exec(ctx)
	return err
}

// WaitForCommand consumes a wakeup hint. Redis failure is intentionally not an
// authority failure: callers still ask the database for an eligible command.
func (q *Queue) WaitForCommand(ctx context.Context, userID string, timeout time.Duration) error {
	if q == nil || q.client == nil || timeout <= 0 {
		return nil
	}
	_, err := q.client.BRPop(ctx, timeout, key(userID)).Result()
	if errors.Is(err, redis.Nil) {
		return nil
	}
	return err
}

func key(userID string) string { return queuePrefix + userID }
