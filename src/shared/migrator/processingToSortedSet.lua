local members = redis.call("SMEMBERS", "processing")
redis.call("DEL", "processing")

local time = redis.call("TIME")[1]

for i = 1, #members, 1
do
  redis.call("ZADD", "processing", time, members[i])
end