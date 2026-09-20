// Package redisctl 是共享池控制面的 Redis 实现。
//
// 它只做唤醒与控制：待派队列、座位、绑定、额度计数器、取消标志、rid → 实例路由。
// 响应字节与账目永远不进这里（约束 1、2）—— 字节在 Hub 进程内直传，账目在 MySQL。
//
// 多键 Lua 决定了它按单机 / 主从部署。要上 Redis Cluster 得先给 cid 与 rid 加同一个
// hash tag，或者把脚本拆成「贡献侧」与「请求侧」两段并接受两者之间的窗口。
//
// 它住在 service 模块里而不是某个 *-api 里：galaxy.ControlPlane 这个端口有两个
// 装配方（galaxy-api 收单派单，manager-api 出运营接口），谁都不该去 import 对方
// 那个可执行模块。领域包 service/galaxy 本身仍然不认识 Redis —— 它只认端口，
// 由装配层注入这里的实现，依赖方向没有变。
package redisctl

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"contract"
	"service/galaxy"
)

const defaultNamespace = "galaxy"

// defaultPoolSize 按「单实例支持 ≥ 500 节点长轮询」这条非功能需求取的下限，
// 再留出心跳、放置、结算这些短请求要用的余量。
const defaultPoolSize = 600

type Options struct {
	Addresses string
	Password  string
	Mode      string
	Namespace string
	DB        int
	// PoolSize 必须大于同时长轮询的节点数。
	//
	// 领活用的是 BLPOP：每个正在长轮询的节点都独占一条连接直到超时（默认 25s）。
	// 连接池小于节点数时，多出来的节点会在 PoolTimeout 上排队失败，表现是
	// 「节点连得上但永远领不到活」，而且日志里只有一行拿不到连接的错误。
	PoolSize int
}

type ControlPlane struct {
	client    redis.UniversalClient
	namespace string
}

// New 返回 nil 表示没配 Redis。共享池没有控制面就不能收单，装配层据此拒绝启动。
func New(options Options) *ControlPlane {
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
	poolSize := options.PoolSize
	if poolSize <= 0 {
		poolSize = defaultPoolSize
	}
	var client redis.UniversalClient
	if strings.EqualFold(strings.TrimSpace(options.Mode), "cluster") {
		client = redis.NewClusterClient(&redis.ClusterOptions{
			Addrs: values, Password: options.Password, PoolSize: poolSize, PoolTimeout: 30 * time.Second,
		})
	} else {
		client = redis.NewUniversalClient(&redis.UniversalOptions{
			Addrs: values, Password: options.Password, DB: options.DB,
			PoolSize: poolSize, PoolTimeout: 30 * time.Second,
		})
	}
	return &ControlPlane{client: client, namespace: namespace}
}

func (c *ControlPlane) Close() error {
	if c == nil || c.client == nil {
		return nil
	}
	return c.client.Close()
}

// ---------- key 布局 ----------

func (c *ControlPlane) key(parts ...string) string {
	return c.namespace + ":" + strings.Join(parts, ":")
}

func (c *ControlPlane) nodeKey(nodeID string) string      { return c.key("node", nodeID) }
func (c *ControlPlane) nodeContribs(nodeID string) string { return c.key("node", nodeID, "contribs") }
func (c *ControlPlane) nodeCancels(nodeID string) string  { return c.key("node", nodeID, "cancel") }
func (c *ControlPlane) contribKey(cid string) string      { return c.key("contrib", cid) }
func (c *ControlPlane) laneKey(lane string) string        { return c.key("lane", lane) }
func (c *ControlPlane) seatsKey(cid string) string        { return c.key("seats", cid) }
func (c *ControlPlane) queueKey(cid string) string        { return c.key("q", cid) }
func (c *ControlPlane) reqKey(rid string) string          { return c.key("req", rid) }
func (c *ControlPlane) bodyKey(rid string) string         { return c.key("req", rid, "body") }
func (c *ControlPlane) cancelKey(rid string) string       { return c.key("cancel", rid) }
func (c *ControlPlane) respKey(id string) string          { return c.key("resp", id) }

func (c *ControlPlane) bindKey(consumerKey, lane string) string {
	return c.key("bind", consumerKey, lane)
}

func (c *ControlPlane) quotaKey(cid string, unit contract.MeterUnit, windowKey, suffix string) string {
	return c.key("quota", cid, unit, windowKey, suffix)
}

// ---------- 节点 ----------

func (c *ControlPlane) RegisterNode(ctx context.Context, node galaxy.NodeRuntime) error {
	values := map[string]any{
		"status":        "active",
		"bridgeVersion": node.BridgeVersion,
		"contract":      node.Contract,
		"instance":      node.Instance,
		"ownerUserId":   node.OwnerUserID,
		"lastBeat":      node.LastBeatAt.UnixMilli(),
		"resources":     encode(node.Resources),
	}
	pipe := c.client.TxPipeline()
	pipe.HSet(ctx, c.nodeKey(node.NodeID), values)
	pipe.Expire(ctx, c.nodeKey(node.NodeID), nodeTTL)
	_, err := pipe.Exec(ctx)
	return err
}

// TouchNode 心跳续期：节点自己的登记项与它名下每个贡献的 key 一起续。
// 45s 不续贡献就自然过期，等价于「摘除该节点的全部贡献」。
//
// 返回值是「这个节点在控制面里还在不在」。不在的时候这里一个字都不写：
// 登记项是 hello 建的，带着 instance / ownerUserId / bridgeVersion / resources，
// 而心跳手上只有 lastBeat 和 status —— 拿这两个字段把它 HSET 回来，得到的是一条
// 缺了大半的登记项，比干脆没有更难查。要补齐得由调用方拿数据库的行重建。
func (c *ControlPlane) TouchNode(ctx context.Context, nodeID string, beatAt time.Time) (bool, error) {
	cids, err := c.client.SMembers(ctx, c.nodeContribs(nodeID)).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return false, err
	}
	pipe := c.client.TxPipeline()
	touched := pipe.Eval(ctx, patchIfExistsLua, []string{c.nodeKey(nodeID)},
		patchArgs(int(nodeTTL.Seconds()), map[string]any{
			"lastBeat": beatAt.UnixMilli(), "status": "active",
		})...)
	for _, cid := range cids {
		// 只给还在的贡献续期。已经过期的不能靠一句心跳复活成「只有 lastBeat」的壳 ——
		// 它没有 kind 也没有 provider，选不上还占着车道，真要回到候选里得走一次 hello，
		// 而节点断连重连本来就会重发 hello。
		pipe.Eval(ctx, patchIfExistsLua, []string{c.contribKey(cid), c.seatsKey(cid)},
			patchArgs(int(contributionTTL.Seconds()), map[string]any{"lastBeat": beatAt.UnixMilli()})...)
	}
	pipe.Expire(ctx, c.nodeContribs(nodeID), nodeTTL)
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return false, err
	}
	found, err := touched.Int64()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return found == 1, nil
}

// contributionTTL 心跳每 15s 一次，45s 收不到就摘除（设计文档 2.3）。
const contributionTTL = 45 * time.Second

// nodeTTL 节点登记项比贡献活得久得多：贡献没了只是这台机器不接新单，
// 登记项没了才是「Hub 眼里这台机器根本不存在」。
const nodeTTL = 24 * time.Hour

// patchIfExistsLua 只给**已经存在**的 key 打补丁，绝不创建。
//
// 控制面里「建一条登记」和「改它的字段」是两件事：节点和贡献都只由 hello 建
// （RegisterNode / ReplaceContributions），其余写入一律是打补丁。用裸 HSET 打补丁，
// 碰上刚过期或压根没建过的 key，就会凭空造出一条只有这次所写字段的残缺登记。
// 这种残缺登记很难发现也很难自愈：字段数不为 0，读的人不会把它当「不存在」跳过，
// 于是它以一个哪儿都对不上的身份继续参与后面的判断。贡献这边的表现是 Lane() 算出 "|"，
// 被塞进一条空车道，放置端在正经车道里怎么找都找不到 —— 界面显示共享中、消费者一路 no_capacity。
//
// KEYS[1] 要打补丁的 key，KEYS[2] 可选的附属 key（跟着一起续期）。
// ARGV[1] 续期秒数，<=0 表示不动 TTL；之后是成对的 field / value。
const patchIfExistsLua = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local ttl = tonumber(ARGV[1])
if #ARGV > 1 then redis.call('HSET', KEYS[1], unpack(ARGV, 2)) end
if ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
  if KEYS[2] ~= nil then redis.call('EXPIRE', KEYS[2], ttl) end
end
return 1`

func patchArgs(ttlSeconds int, fields map[string]any) []any {
	args := make([]any, 0, 1+len(fields)*2)
	args = append(args, ttlSeconds)
	for field, value := range fields {
		args = append(args, field, value)
	}
	return args
}

func (c *ControlPlane) DropNode(ctx context.Context, nodeID string) error {
	cids, err := c.client.SMembers(ctx, c.nodeContribs(nodeID)).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return err
	}
	pipe := c.client.TxPipeline()
	for _, cid := range cids {
		lane, _ := c.client.HGet(ctx, c.contribKey(cid), "lane").Result()
		if lane != "" {
			pipe.SRem(ctx, c.laneKey(lane), cid)
		}
		pipe.Del(ctx, c.contribKey(cid), c.seatsKey(cid))
	}
	pipe.Del(ctx, c.nodeKey(nodeID), c.nodeContribs(nodeID))
	_, err = pipe.Exec(ctx)
	return err
}

// ---------- 贡献 ----------

// ReplaceContributions 是 hello 的语义：全量替换。不再申报的贡献立刻从候选里消失，
// 但它的队列与在途单元不动 —— 排空由 draining 负责，不是靠删 key。
func (c *ControlPlane) ReplaceContributions(ctx context.Context, nodeID string, snapshots []galaxy.ContributionSnapshot) error {
	existing, err := c.client.SMembers(ctx, c.nodeContribs(nodeID)).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return err
	}
	keep := map[string]bool{}
	for _, snapshot := range snapshots {
		keep[snapshot.CID] = true
	}
	pipe := c.client.TxPipeline()
	for _, cid := range existing {
		if keep[cid] {
			continue
		}
		if lane, _ := c.client.HGet(ctx, c.contribKey(cid), "lane").Result(); lane != "" {
			pipe.SRem(ctx, c.laneKey(lane), cid)
		}
		pipe.Del(ctx, c.contribKey(cid), c.seatsKey(cid))
		pipe.SRem(ctx, c.nodeContribs(nodeID), cid)
	}
	for _, snapshot := range snapshots {
		lane := snapshot.Lane()
		values := map[string]any{
			"nodeId": snapshot.NodeID, "ownerUserId": snapshot.OwnerUserID,
			"kind": snapshot.Kind, "kindVersion": snapshot.KindVersion, "provider": snapshot.Provider,
			"lane": lane, "modelsAllow": encode(snapshot.ModelsAllow), "modelsDeny": encode(snapshot.ModelsDeny),
			"seats": snapshot.Seats, "seatConc": snapshot.SeatConcurrency,
			"schedule": encode(snapshot.Schedule), "reputation": snapshot.Reputation,
			"resources":  encode(snapshot.Resources),
			"upstreamOK": boolToInt(snapshot.UpstreamOK), "draining": boolToInt(snapshot.Draining),
			"paused": boolToInt(snapshot.Paused), "lastBeat": snapshot.LastBeatAt.UnixMilli(),
		}
		for unit, limit := range snapshot.QuotaLimit {
			values["limit:"+unit] = limit
		}
		pipe.HSet(ctx, c.contribKey(snapshot.CID), values)
		// inflight 只在贡献刚建立时初始化：hello 是全量替换配置，不是清空在途计数。
		pipe.HSetNX(ctx, c.contribKey(snapshot.CID), "inflight", 0)
		pipe.Expire(ctx, c.contribKey(snapshot.CID), contributionTTL)
		pipe.SAdd(ctx, c.laneKey(lane), snapshot.CID)
		pipe.SAdd(ctx, c.nodeContribs(nodeID), snapshot.CID)
	}
	pipe.Expire(ctx, c.nodeContribs(nodeID), nodeTTL)
	_, err = pipe.Exec(ctx)
	return err
}

// SyncQuota 用当前窗口的计数器重算 used / left。窗口翻转后的恢复就发生在这里：
// 新窗口的计数器是空的，left 自然回到 limit。
func (c *ControlPlane) SyncQuota(ctx context.Context, cid string, limits contract.Metering, windowKeys map[contract.MeterUnit]string) (used, reserved contract.Metering, err error) {
	units := limits.Units()
	if len(units) == 0 {
		return contract.Metering{}, contract.Metering{}, nil
	}
	keys := make([]string, 0, len(units)*2)
	for _, unit := range units {
		window := windowKeys[unit]
		keys = append(keys, c.quotaKey(cid, unit, window, "used"), c.quotaKey(cid, unit, window, "reserved"))
	}
	values, err := c.client.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, nil, err
	}
	used = contract.Metering{}
	reserved = contract.Metering{}
	fields := map[string]any{}
	for index, unit := range units {
		usedValue := parseInt(values[index*2])
		reservedValue := parseInt(values[index*2+1])
		used[unit] = usedValue
		reserved[unit] = reservedValue
		fields["limit:"+unit] = limits[unit]
		fields["used:"+unit] = usedValue
		fields["left:"+unit] = limits[unit] - usedValue - reservedValue
	}
	// 贡献不在控制面里就只算不写：控制台改额度时那条贡献可能还没 hello 过，
	// 这里一写就是一个只有 limit/used/left、没有 kind 与 provider 的壳。
	if err := c.client.Eval(ctx, patchIfExistsLua, []string{c.contribKey(cid)}, patchArgs(0, fields)...).Err(); err != nil {
		return nil, nil, err
	}
	return used, reserved, nil
}

func (c *ControlPlane) UpdateLaneRuntime(ctx context.Context, runtimes []galaxy.LaneRuntime) error {
	if len(runtimes) == 0 {
		return nil
	}
	pipe := c.client.TxPipeline()
	for _, runtime := range runtimes {
		values := map[string]any{
			"upstreamOK": boolToInt(runtime.UpstreamOK),
			"paused":     boolToInt(runtime.Paused),
			"queued":     runtime.Queued,
		}
		if !runtime.ThrottledUntil.IsZero() {
			// 心跳可能晚于 429 收尾到达，空值或旧时间不能清掉较新的冷却。
			// 用绝对时间判断到期，无需主动写零。
			pipe.Eval(ctx, `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local current = tonumber(redis.call('HGET', KEYS[1], 'throttledUntil') or '0')
local incoming = tonumber(ARGV[1])
if incoming > current then redis.call('HSET', KEYS[1], 'throttledUntil', incoming) end
return 1`, []string{c.contribKey(runtime.CID)}, runtime.ThrottledUntil.UnixMilli())
		}
		if len(runtime.CachedArtifacts) > 0 {
			values["cachedArtifacts"] = encode(runtime.CachedArtifacts)
		}
		// 节点每 15s 报一次通道状态。贡献不在控制面里（还没 hello、或哈希已过期）时
		// 这一步必须什么都不做，否则每个心跳都在造一个新的空壳。
		pipe.Eval(ctx, patchIfExistsLua, []string{c.contribKey(runtime.CID)},
			patchArgs(int(contributionTTL.Seconds()), values)...)
	}
	_, err := pipe.Exec(ctx)
	return err
}

// SetDraining 只在贡献已经在控制面里时才写。
//
// 裸 HSET 会在一个不存在的 key 上凭空建出「只有 draining 一个字段」的壳：
// 它没有 kind 也没有 provider，Lane() 算出来是 "|"，而且没有 TTL 所以永远不消失。
// 之后任何把它当快照读的人都会被带偏 —— SaveContributionLimits 读到它会
// found=true，接着把这条贡献 SAdd 进 galaxy:lane:| 那个空车道，
// 放置端在正经车道里怎么找都找不到它。踩过一次，表现是「界面共享中但一直 503」。
func (c *ControlPlane) SetDraining(ctx context.Context, cid string, draining bool) error {
	return c.client.Eval(ctx, patchIfExistsLua, []string{c.contribKey(cid)},
		patchArgs(0, map[string]any{"draining": boolToInt(draining)})...).Err()
}

// SetReputation 同 SetDraining，只给已经存在的快照打补丁，不续期 —— 续期是心跳的事。
func (c *ControlPlane) SetReputation(ctx context.Context, cids []string, reputation float64) error {
	if len(cids) == 0 {
		return nil
	}
	pipe := c.client.Pipeline()
	for _, cid := range cids {
		pipe.Eval(ctx, patchIfExistsLua, []string{c.contribKey(cid)},
			patchArgs(0, map[string]any{"reputation": reputation})...)
	}
	_, err := pipe.Exec(ctx)
	return err
}

func (c *ControlPlane) ListLaneContributions(ctx context.Context, lane string) ([]galaxy.ContributionSnapshot, error) {
	cids, err := c.client.SMembers(ctx, c.laneKey(lane)).Result()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, nil
		}
		return nil, err
	}
	snapshots, missing, err := c.loadContributions(ctx, cids)
	if err != nil {
		return nil, err
	}
	// 顺手把死成员摘掉。
	//
	// lane 集合没有 TTL，而两条正规的 SREM 路径（hello 的全量替换、撤销时的 DropNode）
	// 都得先从 contrib 哈希里读出 lane 字段才知道该动哪条 —— 那个哈希 45 秒就过期，
	// 于是节点掉线久一点再撤销，成员就永远留在这里了，只增不减。
	// 放置本来就要把这条 lane 整个读一遍，在这儿清是零额外开销，而且不挑成因：
	// 不管什么原因留下的死成员，第一次被读到就消失。
	//
	// 被误摘的代价也有限：能走到这里说明哈希已经不在，那条贡献本来就选不上
	// （Place 的 Lua 第一件事就是 EXISTS contribKey），要回到候选里得靠一次 hello，
	// 而节点断连重连本来就会重发 hello。
	if len(missing) > 0 {
		members := make([]any, 0, len(missing))
		for _, cid := range missing {
			members = append(members, cid)
		}
		_ = c.client.SRem(ctx, c.laneKey(lane), members...).Err()
	}
	return snapshots, nil
}

func (c *ControlPlane) ListNodeContributions(ctx context.Context, nodeID string) ([]galaxy.ContributionSnapshot, error) {
	cids, err := c.client.SMembers(ctx, c.nodeContribs(nodeID)).Result()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, nil
		}
		return nil, err
	}
	snapshots, _, err := c.loadContributions(ctx, cids)
	return snapshots, err
}

// loadContributions 第二个返回值是「哈希已经不在」的那些 cid。调用方要是手里握着
// 一份成员表（lane 集合），可以据此把死成员摘掉；节点视角不需要，那张表有 TTL。
func (c *ControlPlane) loadContributions(ctx context.Context, cids []string) ([]galaxy.ContributionSnapshot, []string, error) {
	if len(cids) == 0 {
		return nil, nil, nil
	}
	pipe := c.client.Pipeline()
	hashes := make([]*redis.MapStringStringCmd, len(cids))
	seats := make([]*redis.IntCmd, len(cids))
	for index, cid := range cids {
		hashes[index] = pipe.HGetAll(ctx, c.contribKey(cid))
		seats[index] = pipe.ZCount(ctx, c.seatsKey(cid), strconv.FormatInt(time.Now().UnixMilli(), 10), "+inf")
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, nil, err
	}
	snapshots := make([]galaxy.ContributionSnapshot, 0, len(cids))
	var missing []string
	for index, cid := range cids {
		values, err := hashes[index].Result()
		if err != nil || len(values) == 0 {
			// key 过期即摘除，这是心跳超时的自然结果。
			missing = append(missing, cid)
			continue
		}
		snapshot := decodeSnapshot(cid, values)
		snapshot.SeatsUsed = int(seats[index].Val())
		snapshots = append(snapshots, snapshot)
	}
	return snapshots, missing, nil
}

func (c *ControlPlane) GetContribution(ctx context.Context, cid string) (galaxy.ContributionSnapshot, bool, error) {
	values, err := c.client.HGetAll(ctx, c.contribKey(cid)).Result()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return galaxy.ContributionSnapshot{}, false, nil
		}
		return galaxy.ContributionSnapshot{}, false, err
	}
	if len(values) == 0 {
		return galaxy.ContributionSnapshot{}, false, nil
	}
	snapshot := decodeSnapshot(cid, values)
	seats, err := c.client.ZCount(ctx, c.seatsKey(cid), strconv.FormatInt(time.Now().UnixMilli(), 10), "+inf").Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return galaxy.ContributionSnapshot{}, false, err
	}
	snapshot.SeatsUsed = int(seats)
	return snapshot, true, nil
}

// ---------- 绑定 ----------

func (c *ControlPlane) LookupBinding(ctx context.Context, consumerKey, lane string) (string, bool, error) {
	cid, err := c.client.Get(ctx, c.bindKey(consumerKey, lane)).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return cid, cid != "", nil
}

func (c *ControlPlane) ReleaseBinding(ctx context.Context, consumerKey, lane, cid string) error {
	pipe := c.client.TxPipeline()
	pipe.Del(ctx, c.bindKey(consumerKey, lane))
	pipe.ZRem(ctx, c.seatsKey(cid), consumerKey)
	// 在途计数跟着一起清：留着它，这个消费者往后每次结算都以为「还有别的请求在跑」，
	// 于是座位再也收不回到「现在 + 空闲窗口」。
	pipe.HDel(ctx, c.contribKey(cid), "run:"+consumerKey)
	_, err := pipe.Exec(ctx)
	return err
}

// ---------- 放置与领活 ----------

func (c *ControlPlane) Place(ctx context.Context, command galaxy.PlaceCommand) (galaxy.PlaceOutcome, error) {
	now := time.Now()
	units := command.Estimate.Units()
	argv := []any{
		command.RID, command.CID, command.ConsumerKey,
		command.Seats, command.Seats * command.SeatConcurrency,
		int64(command.BindTTL.Seconds()), command.SeatTTL.Milliseconds(), now.UnixMilli(),
		string(command.Unit), int64(command.BodyTTL.Seconds()), command.Instance,
		command.Deadline.UnixMilli(), encode(command.Estimate), string(command.Body),
	}
	quota := make([]any, 0, len(units)*6)
	count := 0
	for _, unit := range units {
		limit, ok := command.QuotaLimits[unit]
		if !ok || limit <= 0 {
			continue // 没有授权行的单位不限量，不参与预留
		}
		window := command.WindowKeys[unit]
		expiry := int64(command.WindowExpiry[unit].Seconds())
		if expiry <= 0 {
			expiry = 86400
		}
		quota = append(quota, unit,
			c.quotaKey(command.CID, unit, window, "used"),
			c.quotaKey(command.CID, unit, window, "reserved"),
			limit, command.Estimate[unit], expiry)
		count++
	}
	argv = append(argv, count)
	argv = append(argv, quota...)

	keys := []string{
		c.contribKey(command.CID), c.seatsKey(command.CID),
		c.bindKey(command.ConsumerKey, command.Lane), c.queueKey(command.CID),
		c.reqKey(command.RID), c.bodyKey(command.RID),
	}
	raw, err := placeScript.Run(ctx, c.client, keys, argv...).Result()
	if err != nil {
		return galaxy.PlaceOutcome{}, err
	}
	values, ok := raw.([]any)
	if !ok || len(values) < 3 {
		return galaxy.PlaceOutcome{}, fmt.Errorf("放置脚本返回了预期之外的结果")
	}
	if toInt64(values[0]) == 1 {
		return galaxy.PlaceOutcome{Placed: true}, nil
	}
	return galaxy.PlaceOutcome{
		Reason: galaxy.PlaceRejection(toString(values[1])),
		Unit:   toString(values[2]),
	}, nil
}

// Claim 长轮询领活：只在节点列出的、有空位的通道上阻塞（T-03）。
func (c *ControlPlane) Claim(ctx context.Context, command galaxy.ClaimCommand) (*galaxy.ClaimedUnit, error) {
	if len(command.CIDs) == 0 {
		return nil, nil
	}
	keys := make([]string, 0, len(command.CIDs))
	for _, cid := range command.CIDs {
		keys = append(keys, c.queueKey(cid))
	}
	result, err := c.client.BLPop(ctx, command.Wait, keys...).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		if ctx.Err() != nil {
			return nil, nil
		}
		return nil, err
	}
	if len(result) < 2 {
		return nil, nil
	}
	rid := result[1]
	cid := strings.TrimPrefix(result[0], c.key("q")+":")

	pipe := c.client.Pipeline()
	fields := pipe.HGetAll(ctx, c.reqKey(rid))
	body := pipe.Get(ctx, c.bodyKey(rid))
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	values, err := fields.Result()
	if err != nil || len(values) == 0 {
		// req 已经过期：单元早就结束了，当作没领到。
		return nil, nil
	}
	claimed := &galaxy.ClaimedUnit{
		RID: rid, CID: cid, Unit: []byte(values["unit"]),
		Body: []byte(body.Val()), Instance: values["instance"],
	}
	if deadline := parseInt(values["deadline"]); deadline > 0 {
		claimed.Deadline = time.UnixMilli(deadline)
	}
	return claimed, nil
}

// ---------- 单元 ----------

func (c *ControlPlane) LoadUnit(ctx context.Context, rid string) (galaxy.UnitRuntime, bool, error) {
	values, err := c.client.HGetAll(ctx, c.reqKey(rid)).Result()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return galaxy.UnitRuntime{}, false, nil
		}
		return galaxy.UnitRuntime{}, false, err
	}
	if len(values) == 0 {
		return galaxy.UnitRuntime{}, false, nil
	}
	runtime := galaxy.UnitRuntime{
		RID: rid, ConsumerKey: values["consumerKey"], CID: values["cid"],
		Instance: values["instance"], State: contract.UnitState(values["state"]), Lease: values["lease"],
		Estimate: decodeMetering(values["estimate"]), HubUsage: decodeMetering(values["hubUsage"]),
		Envelope: []byte(values["unit"]),
	}
	if placed := parseInt(values["placedAt"]); placed > 0 {
		runtime.PlacedAt = time.UnixMilli(placed)
	}
	if first := parseInt(values["firstByteAt"]); first > 0 {
		runtime.FirstByteAt = time.UnixMilli(first)
	}
	if deadline := parseInt(values["deadline"]); deadline > 0 {
		runtime.Deadline = time.UnixMilli(deadline)
	}
	// kind / provider / attempt 从信封里取，避免再多存一份可能不一致的副本。
	var unit contract.WorkUnit
	if raw := values["unit"]; raw != "" {
		if err := json.Unmarshal([]byte(raw), &unit); err == nil {
			runtime.Kind = unit.Kind
			runtime.KindVersion = unit.KindVersion
			runtime.Provider = unit.Provider
			runtime.Model = unit.Model
			runtime.SID = unit.SID
			runtime.Attempt = unit.Attempt
		}
	}
	if runtime.Attempt <= 0 {
		runtime.Attempt = 1
	}
	return runtime, true, nil
}

func (c *ControlPlane) MarkRunning(ctx context.Context, rid, lease string, at time.Time) error {
	return c.client.HSet(ctx, c.reqKey(rid), "state", "running", "lease", lease, "leaseAt", at.UnixMilli()).Err()
}

func (c *ControlPlane) MarkFirstByte(ctx context.Context, rid string, at time.Time) error {
	return c.client.HSet(ctx, c.reqKey(rid), "firstByteAt", at.UnixMilli(), "state", "streaming").Err()
}

// LeaseExpired 租约过期判定。没派过租约的单元（还在队列里没人领）不算过期 ——
// 那是「还没开始」，不是「跑丢了」。
func (c *ControlPlane) LeaseExpired(ctx context.Context, rid string, grace time.Duration) (bool, error) {
	values, err := c.client.HMGet(ctx, c.reqKey(rid), "lease", "leaseAt", "state").Result()
	if err != nil {
		return false, err
	}
	if len(values) < 3 || toString(values[0]) == "" {
		return false, nil
	}
	if toString(values[2]) == "settled" {
		return false, nil
	}
	leaseAt := parseInt(values[1])
	if leaseAt <= 0 {
		return false, nil
	}
	return time.Since(time.UnixMilli(leaseAt)) > grace, nil
}

func (c *ControlPlane) RecordHubUsage(ctx context.Context, rid string, usage contract.Metering) error {
	return c.client.HSet(ctx, c.reqKey(rid), "hubUsage", encode(usage)).Err()
}

// Settle 脚本的返回值是「这次真的结了没有」：单元已经是 settled 时它直接回 0，
// 不再动并发、额度与座位。以前这个结果被丢掉，调用方无从分辨重放 ——
// 于是一次重发的 complete 会让提供者被重复入账（账本幂等，余额不是）。
func (c *ControlPlane) Settle(ctx context.Context, command galaxy.SettleCommand) (bool, error) {
	units := map[contract.MeterUnit]bool{}
	for unit := range command.Estimate {
		units[unit] = true
	}
	for unit := range command.Actual {
		units[unit] = true
	}
	ordered := make([]contract.MeterUnit, 0, len(units))
	for unit := range units {
		ordered = append(ordered, unit)
	}
	sortUnits(ordered)

	seatTTL := command.SeatTTL
	if seatTTL <= 0 {
		// 兜底：没给窗口就按一分钟收。给 0 会让座位当场过期。
		seatTTL = time.Minute
	}
	bindTTL := command.BindTTL
	if bindTTL < seatTTL {
		// 绑定只是「上次落在哪台」的偏好，短于座位没有意义：座位还占着、
		// 偏好先忘了，下一条请求会去挑别的机器，而这台的座位仍记在他名下。
		bindTTL = seatTTL
	}
	argv := []any{
		command.ConsumerKey, boolToInt(command.ReleaseSeat), string(command.State),
		time.Now().UnixMilli(), seatTTL.Milliseconds(), bindTTL.Milliseconds(), len(ordered),
	}
	for _, unit := range ordered {
		window := command.WindowKeys[unit]
		argv = append(argv, unit,
			c.quotaKey(command.CID, unit, window, "used"),
			c.quotaKey(command.CID, unit, window, "reserved"),
			command.Estimate[unit], command.Actual[unit], int64((30 * 24 * time.Hour).Seconds()))
	}
	argv = append(argv, command.CID)

	keys := []string{
		c.contribKey(command.CID), c.seatsKey(command.CID),
		c.bindKey(command.ConsumerKey, command.Lane), c.reqKey(command.RID),
	}
	settled, err := settleScript.Run(ctx, c.client, keys, argv...).Int64()
	if err != nil {
		return false, err
	}
	return settled == 1, nil
}

// ---------- 取消 ----------

// RequestCancel 取消搭在节点已有的长轮询与心跳上，不单独开一路轮询（T-05）。
func (c *ControlPlane) RequestCancel(ctx context.Context, rid, reason string) error {
	if err := c.client.Set(ctx, c.cancelKey(rid), reason, 2*time.Minute).Err(); err != nil {
		return err
	}
	cid, err := c.client.HGet(ctx, c.reqKey(rid), "cid").Result()
	if err != nil || cid == "" {
		return nil
	}
	nodeID, err := c.client.HGet(ctx, c.contribKey(cid), "nodeId").Result()
	if err != nil || nodeID == "" {
		return nil
	}
	pipe := c.client.TxPipeline()
	pipe.LPush(ctx, c.nodeCancels(nodeID), rid)
	pipe.LTrim(ctx, c.nodeCancels(nodeID), 0, 255)
	pipe.Expire(ctx, c.nodeCancels(nodeID), 10*time.Minute)
	_, err = pipe.Exec(ctx)
	return err
}

func (c *ControlPlane) CancelRequested(ctx context.Context, rid string) (bool, error) {
	count, err := c.client.Exists(ctx, c.cancelKey(rid)).Result()
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// TakeNodeCancels 取走并清空该节点待下发的取消列表。
func (c *ControlPlane) TakeNodeCancels(ctx context.Context, nodeID string) ([]string, error) {
	pipe := c.client.TxPipeline()
	values := pipe.LRange(ctx, c.nodeCancels(nodeID), 0, -1)
	pipe.Del(ctx, c.nodeCancels(nodeID))
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	return values.Val(), nil
}

// ---------- Responses 链式亲和 ----------

func (c *ControlPlane) RememberResponse(ctx context.Context, responseID, cid string, ttl time.Duration) error {
	return c.client.Set(ctx, c.respKey(responseID), cid, ttl).Err()
}

func (c *ControlPlane) LookupResponse(ctx context.Context, responseID string) (string, bool, error) {
	cid, err := c.client.Get(ctx, c.respKey(responseID)).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return cid, true, nil
}

// BumpProbeBudget 抽检的每日配额。计数器活到第二天：
// 抽检的上限是「每贡献每日」，跨天就该从头算。
func (c *ControlPlane) BumpProbeBudget(ctx context.Context, cid, day string) (int64, error) {
	key := c.key("probe", cid, day)
	pipe := c.client.TxPipeline()
	count := pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, 48*time.Hour)
	if _, err := pipe.Exec(ctx); err != nil {
		return 0, err
	}
	return count.Val(), nil
}

func (c *ControlPlane) Healthy(ctx context.Context) error {
	return c.client.Ping(ctx).Err()
}

var _ galaxy.ControlPlane = (*ControlPlane)(nil)
