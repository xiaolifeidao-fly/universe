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
	pipe.Expire(ctx, c.nodeKey(node.NodeID), 24*time.Hour)
	_, err := pipe.Exec(ctx)
	return err
}

// TouchNode 心跳续期：节点自己的 key 与它名下每个贡献的 key 一起续。
// 45s 不续就自然过期，等价于「摘除该节点的全部贡献」。
func (c *ControlPlane) TouchNode(ctx context.Context, nodeID string, beatAt time.Time) error {
	cids, err := c.client.SMembers(ctx, c.nodeContribs(nodeID)).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return err
	}
	pipe := c.client.TxPipeline()
	pipe.HSet(ctx, c.nodeKey(nodeID), "lastBeat", beatAt.UnixMilli(), "status", "active")
	pipe.Expire(ctx, c.nodeKey(nodeID), 24*time.Hour)
	for _, cid := range cids {
		pipe.HSet(ctx, c.contribKey(cid), "lastBeat", beatAt.UnixMilli())
		pipe.Expire(ctx, c.contribKey(cid), contributionTTL)
		pipe.Expire(ctx, c.seatsKey(cid), contributionTTL)
	}
	pipe.Expire(ctx, c.nodeContribs(nodeID), 24*time.Hour)
	_, err = pipe.Exec(ctx)
	return err
}

// contributionTTL 心跳每 15s 一次，45s 收不到就摘除（设计文档 2.3）。
const contributionTTL = 45 * time.Second

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
	pipe.Expire(ctx, c.nodeContribs(nodeID), 24*time.Hour)
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
	if err := c.client.HSet(ctx, c.contribKey(cid), fields).Err(); err != nil {
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
			values["throttledUntil"] = runtime.ThrottledUntil.UnixMilli()
		} else {
			values["throttledUntil"] = 0
		}
		if len(runtime.CachedArtifacts) > 0 {
			values["cachedArtifacts"] = encode(runtime.CachedArtifacts)
		}
		pipe.HSet(ctx, c.contribKey(runtime.CID), values)
		pipe.Expire(ctx, c.contribKey(runtime.CID), contributionTTL)
	}
	_, err := pipe.Exec(ctx)
	return err
}

func (c *ControlPlane) SetDraining(ctx context.Context, cid string, draining bool) error {
	return c.client.HSet(ctx, c.contribKey(cid), "draining", boolToInt(draining)).Err()
}

func (c *ControlPlane) ListLaneContributions(ctx context.Context, lane string) ([]galaxy.ContributionSnapshot, error) {
	cids, err := c.client.SMembers(ctx, c.laneKey(lane)).Result()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, nil
		}
		return nil, err
	}
	return c.loadContributions(ctx, cids)
}

func (c *ControlPlane) ListNodeContributions(ctx context.Context, nodeID string) ([]galaxy.ContributionSnapshot, error) {
	cids, err := c.client.SMembers(ctx, c.nodeContribs(nodeID)).Result()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, nil
		}
		return nil, err
	}
	return c.loadContributions(ctx, cids)
}

func (c *ControlPlane) loadContributions(ctx context.Context, cids []string) ([]galaxy.ContributionSnapshot, error) {
	if len(cids) == 0 {
		return nil, nil
	}
	pipe := c.client.Pipeline()
	hashes := make([]*redis.MapStringStringCmd, len(cids))
	seats := make([]*redis.IntCmd, len(cids))
	for index, cid := range cids {
		hashes[index] = pipe.HGetAll(ctx, c.contribKey(cid))
		seats[index] = pipe.ZCount(ctx, c.seatsKey(cid), strconv.FormatInt(time.Now().UnixMilli(), 10), "+inf")
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	snapshots := make([]galaxy.ContributionSnapshot, 0, len(cids))
	for index, cid := range cids {
		values, err := hashes[index].Result()
		if err != nil || len(values) == 0 {
			continue // key 过期即摘除，这是心跳超时的自然结果
		}
		snapshot := decodeSnapshot(cid, values)
		snapshot.SeatsUsed = int(seats[index].Val())
		snapshots = append(snapshots, snapshot)
	}
	return snapshots, nil
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
		boolToInt(command.ReuseBinding),
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

func (c *ControlPlane) Settle(ctx context.Context, command galaxy.SettleCommand) error {
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

	argv := []any{command.ConsumerKey, boolToInt(command.ReleaseSeat), string(command.State), len(ordered)}
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
	return settleScript.Run(ctx, c.client, keys, argv...).Err()
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
