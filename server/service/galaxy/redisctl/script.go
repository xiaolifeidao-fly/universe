package redisctl

import "github.com/redis/go-redis/v9"

// 放置：占座位 → 预留额度 → 入队 → 写 req，全部原子。
//
// 为什么必须是一段脚本：这几步之间任何一处让别的请求插进来，都会出现
// 「两个消费者抢到同一个最后的座位」或者「额度已经超了但单元已经入队」。
//
// 这里有两条时间线，长短不同，别混成一件事：
//
//	座位（seats ZSET）  谁正占着这台机器。空闲窗口很短（默认 1 分钟），
//	                    主人界面上那颗「有 N 位使用者绑在这台上」数的就是它。
//	绑定（bind key）    上次落在哪台。记得久得多（默认 30 分钟），只是**偏好**：
//	                    回头客先试那台，位子被别人占满了就照常去挑别的机器。
//
// KEYS: 1 contrib  2 seats  3 bind  4 queue  5 req  6 body
// ARGV: 1 rid 2 cid 3 consumerKey 4 seats 5 concurrency 6 bindTTL(s)
//
//	7 seatTTL(ms) 8 nowMs 9 unitJSON 10 bodyTTL(s) 11 instance 12 deadlineMs
//	13 estimateJSON 14 body 15 quotaCount
//	之后每个单位 5 个：unit, usedKey, reservedKey, limit, estimate, expiry(s)
var placeScript = redis.NewScript(`
local contribKey, seatsKey, bindKey, queueKey, reqKey, bodyKey =
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6]

if redis.call('EXISTS', contribKey) == 0 then
  return {0, 'offline', ''}
end

local rid          = ARGV[1]
local cid          = ARGV[2]
local consumerKey  = ARGV[3]
local seats        = tonumber(ARGV[4])
local concurrency  = tonumber(ARGV[5])
local bindTTL      = tonumber(ARGV[6])
local seatTTL      = tonumber(ARGV[7])
local now          = tonumber(ARGV[8])
local unitJSON     = ARGV[9]
local bodyTTL      = tonumber(ARGV[10])
local instance     = ARGV[11]
local deadline     = ARGV[12]
local deadlineMs   = tonumber(ARGV[12]) or 0
local estimateJSON = ARGV[13]
local body         = ARGV[14]
local quotaCount   = tonumber(ARGV[15])

-- 过期座位先回收：座位是带 TTL 的粘性绑定，主人停机或消费者走了都不该一直占着。
redis.call('ZREMRANGEBYSCORE', seatsKey, '-inf', now)

-- 座位闸门对「回头客」一视同仁。从前这里有一条 reuse==1 就整段跳过的快捷路径，
-- 它成立的前提是绑定与座位同生共死 —— 拿着绑定回来的人必定还占着座位。
-- 两条时间线拆开之后这个前提没了：绑定还在、座位早就过期，跳过闸门就意味着
-- 一台 3 座的机器能被第 4 个人挤进来。还占着座位的人照样放行，ZSCORE 就是为他留的。
local held = redis.call('ZSCORE', seatsKey, consumerKey)
if not held and redis.call('ZCARD', seatsKey) >= seats then
  return {0, 'seats_full', ''}
end

local inflight = redis.call('HINCRBY', contribKey, 'inflight', 1)
if inflight > concurrency then
  redis.call('HINCRBY', contribKey, 'inflight', -1)
  return {0, 'concurrency_full', ''}
end

-- 额度预留。任一维度不够就把已经预留的全部回滚 —— 三维同时生效，不存在部分预留。
local reservedFields = {}
local base = 16
for i = 0, quotaCount - 1 do
  local unit        = ARGV[base + i * 6]
  local usedKey     = ARGV[base + i * 6 + 1]
  local reservedKey = ARGV[base + i * 6 + 2]
  local limit       = tonumber(ARGV[base + i * 6 + 3])
  local estimate    = tonumber(ARGV[base + i * 6 + 4])
  local expiry      = tonumber(ARGV[base + i * 6 + 5])

  local used     = tonumber(redis.call('GET', usedKey) or '0')
  local reserved = tonumber(redis.call('GET', reservedKey) or '0')
  if used + reserved + estimate > limit then
    for _, entry in ipairs(reservedFields) do
      redis.call('DECRBY', entry[1], entry[2])
      redis.call('HINCRBY', contribKey, 'left:' .. entry[3], entry[2])
    end
    redis.call('HINCRBY', contribKey, 'inflight', -1)
    return {0, 'quota_exceeded', unit}
  end
  redis.call('INCRBY', reservedKey, estimate)
  redis.call('EXPIRE', reservedKey, expiry)
  redis.call('HINCRBY', contribKey, 'left:' .. unit, -estimate)
  table.insert(reservedFields, {reservedKey, estimate, unit})
end

-- 座位与绑定至少活到这条请求的截止时刻之后。空闲窗口算的是「最后一次活动**结束**
-- 之后闲了多久」，而正在跑的请求本身就是活动。窗口比单次请求短的时候（现在默认 1 分钟，
-- llm.chat 一条能跑 10 分钟）少了这一句，座位会在流还没推完时就过期：界面显示没人在用，
-- 别的消费者还能挤进来，超过主人设定的座位数。结算时再收回到「现在 + 空闲窗口」。
local seatUntil = now + seatTTL
if deadlineMs + seatTTL > seatUntil then seatUntil = deadlineMs + seatTTL end
local bindPX = bindTTL * 1000
if seatUntil - now > bindPX then bindPX = seatUntil - now end
redis.call('ZADD', seatsKey, seatUntil, consumerKey)
redis.call('SET', bindKey, cid, 'PX', bindPX)
-- run:<consumerKey> 是这个消费者在这台机器上还没结算的请求数。结算靠它分辨
-- 「是不是最后一条」—— 同时跑着两条时，先结完的那条不能把座位收短。
redis.call('HINCRBY', contribKey, 'run:' .. consumerKey, 1)
redis.call('HSET', contribKey, 'seatsUsed', redis.call('ZCARD', seatsKey), 'lastBoundAt', now)

redis.call('HSET', reqKey,
  'consumerKey', consumerKey, 'cid', cid, 'instance', instance,
  'state', 'placed', 'deadline', deadline, 'estimate', estimateJSON,
  'unit', unitJSON, 'placedAt', now, 'lease', '', 'firstByteAt', '', 'hubUsage', '')
redis.call('EXPIRE', reqKey, 86400)
if body ~= '' then
  redis.call('SET', bodyKey, body, 'EX', bodyTTL)
end
redis.call('LPUSH', queueKey, rid)
return {1, '', ''}
`)

// 结算：回补额度、释放并发与座位。预留按预估回滚，实际用量单独入账，
// 两者分开存才能让「预留—结算」幂等（设计文档 5.3）。
//
// KEYS: 1 contrib  2 seats  3 bind  4 req
// ARGV: 1 consumerKey 2 releaseSeat 3 state 4 nowMs 5 seatTTL(ms) 6 bindTTL(ms) 7 quotaCount
//
//	之后每个单位 6 个：unit, usedKey, reservedKey, estimate, actual, expiry
//	最后 1 个：cid
var settleScript = redis.NewScript(`
local contribKey, seatsKey, bindKey, reqKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local consumerKey = ARGV[1]
local releaseSeat = tonumber(ARGV[2])
local state       = ARGV[3]
local now         = tonumber(ARGV[4])
local seatTTL     = tonumber(ARGV[5])
local bindTTL     = tonumber(ARGV[6])
local quotaCount  = tonumber(ARGV[7])

if redis.call('HGET', reqKey, 'state') == 'settled' then
  return 0
end

-- 这个消费者在这台机器上还剩几条没结算的请求。放置时 +1，这里 -1，
-- 减到 0 才算「他真的闲下来了」，座位的空闲计时从这一刻开始走。
-- 计数只在放置成功之后加，所以脚本里那几条回滚返回的路径不会把它带偏。
local running = redis.call('HINCRBY', contribKey, 'run:' .. consumerKey, -1)
if running <= 0 then
  redis.call('HDEL', contribKey, 'run:' .. consumerKey)
  running = 0
end

local inflight = redis.call('HINCRBY', contribKey, 'inflight', -1)
if inflight < 0 then
  redis.call('HSET', contribKey, 'inflight', 0)
end

local base = 8
for i = 0, quotaCount - 1 do
  local unit        = ARGV[base + i * 6]
  local usedKey     = ARGV[base + i * 6 + 1]
  local reservedKey = ARGV[base + i * 6 + 2]
  local estimate    = tonumber(ARGV[base + i * 6 + 3])
  local actual      = tonumber(ARGV[base + i * 6 + 4])
  local expiry      = tonumber(ARGV[base + i * 6 + 5])

  if estimate > 0 then
    local reserved = tonumber(redis.call('GET', reservedKey) or '0')
    local giveBack = estimate
    if reserved < estimate then giveBack = reserved end
    if giveBack > 0 then
      redis.call('DECRBY', reservedKey, giveBack)
      redis.call('HINCRBY', contribKey, 'left:' .. unit, giveBack)
    end
  end
  if actual > 0 then
    redis.call('INCRBY', usedKey, actual)
    redis.call('EXPIRE', usedKey, expiry)
    redis.call('HINCRBY', contribKey, 'used:' .. unit, actual)
    redis.call('HINCRBY', contribKey, 'left:' .. unit, -actual)
  end
end

local cid = ARGV[base + quotaCount * 6]
if releaseSeat == 1 then
  redis.call('ZREM', seatsKey, consumerKey)
  redis.call('HDEL', contribKey, 'run:' .. consumerKey)
  if redis.call('GET', bindKey) == cid then
    redis.call('DEL', bindKey)
  end
elseif running == 0 then
  -- 最后一条在途请求刚结束，把放置时按截止时刻撑长的座位收回到「现在 + 空闲窗口」。
  -- XX 只改已经存在的成员：座位可能已经被主人摘掉，或者随心跳超时连 key 一起过期了，
  -- 结算不该把它凭空加回来 —— 那会留下一个没有 TTL、永远不掉的座位。
  redis.call('ZADD', seatsKey, 'XX', now + seatTTL, consumerKey)
  -- 绑定走自己那条更长的时间线：座位让出去了，「上次落在哪台」还记着。
  if redis.call('GET', bindKey) == cid then
    redis.call('PEXPIRE', bindKey, bindTTL)
  end
end
redis.call('HSET', contribKey, 'seatsUsed', redis.call('ZCARD', seatsKey))
redis.call('HSET', reqKey, 'state', 'settled', 'finalState', state)
return 1
`)
