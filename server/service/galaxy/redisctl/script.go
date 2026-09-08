package redisctl

import "github.com/redis/go-redis/v9"

// 放置：占座位 → 预留额度 → 入队 → 写 req，全部原子。
//
// 为什么必须是一段脚本：这几步之间任何一处让别的请求插进来，都会出现
// 「两个消费者抢到同一个最后的座位」或者「额度已经超了但单元已经入队」。
// 消费者已绑定时（reuse=1）跳过座位判定，这是 90% 请求走的那条路径。
//
// KEYS: 1 contrib  2 seats  3 bind  4 queue  5 req  6 body
// ARGV: 1 rid 2 cid 3 consumerKey 4 seats 5 concurrency 6 reuse 7 bindTTL(s)
//
//	8 seatTTL(ms) 9 nowMs 10 unitJSON 11 bodyTTL(s) 12 instance 13 deadlineMs
//	14 estimateJSON 15 body 16 quotaCount
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
local reuse        = tonumber(ARGV[6])
local bindTTL      = tonumber(ARGV[7])
local seatTTL      = tonumber(ARGV[8])
local now          = tonumber(ARGV[9])
local unitJSON     = ARGV[10]
local bodyTTL      = tonumber(ARGV[11])
local instance     = ARGV[12]
local deadline     = ARGV[13]
local estimateJSON = ARGV[14]
local body         = ARGV[15]
local quotaCount   = tonumber(ARGV[16])

-- 过期座位先回收：座位是带 TTL 的粘性绑定，主人停机或消费者走了都不该一直占着。
redis.call('ZREMRANGEBYSCORE', seatsKey, '-inf', now)

if reuse == 0 then
  local held = redis.call('ZSCORE', seatsKey, consumerKey)
  if not held and redis.call('ZCARD', seatsKey) >= seats then
    return {0, 'seats_full', ''}
  end
end

local inflight = redis.call('HINCRBY', contribKey, 'inflight', 1)
if inflight > concurrency then
  redis.call('HINCRBY', contribKey, 'inflight', -1)
  return {0, 'concurrency_full', ''}
end

-- 额度预留。任一维度不够就把已经预留的全部回滚 —— 三维同时生效，不存在部分预留。
local reservedFields = {}
local base = 17
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

redis.call('ZADD', seatsKey, now + seatTTL, consumerKey)
redis.call('SET', bindKey, cid, 'EX', bindTTL)
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
// ARGV: 1 consumerKey 2 releaseSeat 3 state 4 quotaCount
//
//	之后每个单位 6 个：unit, usedKey, reservedKey, estimate, actual, expiry
var settleScript = redis.NewScript(`
local contribKey, seatsKey, bindKey, reqKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local consumerKey = ARGV[1]
local releaseSeat = tonumber(ARGV[2])
local state       = ARGV[3]
local quotaCount  = tonumber(ARGV[4])

if redis.call('HGET', reqKey, 'state') == 'settled' then
  return 0
end

local inflight = redis.call('HINCRBY', contribKey, 'inflight', -1)
if inflight < 0 then
  redis.call('HSET', contribKey, 'inflight', 0)
end

local base = 5
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

if releaseSeat == 1 then
  redis.call('ZREM', seatsKey, consumerKey)
  if redis.call('GET', bindKey) == ARGV[5 + quotaCount * 6] then
    redis.call('DEL', bindKey)
  end
end
redis.call('HSET', contribKey, 'seatsUsed', redis.call('ZCARD', seatsKey))
redis.call('HSET', reqKey, 'state', 'settled', 'finalState', state)
return 1
`)
